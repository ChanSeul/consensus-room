#!/usr/bin/env python3
"""Read-only, local usage reconciliation. Never reads message bodies into a report.

Raw request observations are one population; execution aggregates are another.
They are reconciled, never added together. Missing observations are not zero.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import sys

FIELDS = ('inputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'outputTokens')
ROLES = ('runner', 'mediator', 'pre-audit', 'host-review', 'work-admission')


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo else None
    except ValueError:
        return None


def count(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


def read_db(path, query):
    if not path.exists():
        return []
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute(query)]


def json_file(path):
    return json.loads(path.read_text(encoding='utf-8'))


def union_seconds(intervals):
    total = 0
    previous = None
    for start, end in sorted(intervals):
        if previous is None or start > previous[1]:
            if previous:
                total += previous[1] - previous[0]
            previous = [start, end]
        else:
            previous[1] = max(previous[1], end)
    return total + (previous[1] - previous[0] if previous else 0)


class Report:
    def __init__(self, args):
        self.args = args
        self.input_paths = set()
        self.warnings = defaultdict(int)
        self.start = timestamp(args.since) if args.since else None
        self.end = timestamp(args.until) if args.until else None
        if (args.since and self.start is None) or (args.until and self.end is None):
            raise ValueError('기간은 시간대가 포함된 ISO 8601 시각이어야 합니다')
        if self.start is not None and self.end is not None and self.start >= self.end:
            raise ValueError('--from은 --to보다 앞이어야 합니다')
        self.topics = self.database(args.room_home / 'consensus-room.sqlite', 'SELECT id,slug,worktree_path,created_at,updated_at FROM topics ORDER BY created_at')
        self.by_cwd = {row['worktree_path']: row['id'] for row in self.topics}
        self.worktrees = [(row['id'], row['worktree_path']) for row in self.topics]
        tables = self.database(args.room_home / 'consensus-room.sqlite', "SELECT name FROM sqlite_master WHERE type='table'")
        if any(row['name'] == 'timeline_events' for row in tables):
            for row in self.database(args.room_home / 'consensus-room.sqlite', "SELECT topic_id,payload_json FROM timeline_events WHERE kind='scope_change'"):
                path = json.loads(row['payload_json']).get('previousWorktreePath')
                if isinstance(path, str) and path:
                    self.worktrees.append((row['topic_id'], path))
                    if path in self.by_cwd and self.by_cwd[path] != row['topic_id']:
                        raise ValueError('서로 다른 토픽이 같은 worktree를 사용했습니다. 연결 근거를 확인하세요')
                    self.by_cwd[path] = row['topic_id']
        self.topic_ids = {row['id'] for row in self.topics}
        if args.topic and args.topic not in self.topic_ids:
            match = [row['id'] for row in self.topics if row['slug'] == args.topic]
            if len(match) != 1:
                raise ValueError('토픽 ID 또는 slug를 정확하게 지정하세요')
            args.topic = match[0]
        self.mapping = self.read_json(args.mapping) if args.mapping else {}
        self.requests = {}
        self.sources = []
        self.executions = []
        self.seen_files = set()

    def database(self, path, query):
        self.input_paths.add(path.resolve())
        return read_db(path, query)

    def read_json(self, path):
        self.input_paths.add(path.resolve())
        return json_file(path)

    def merge_request(self, previous, item):
        times = [t for t in (previous['at'], item['at']) if t is not None]
        previous['at'] = min(times) if times else None
        if previous['provider'] == 'claude' and previous['topic'] == item['topic']:
            for field, value in item['values'].items():
                previous['values'][field] = max(value, previous['values'].get(field, 0))
        elif previous['values'] != item['values'] or previous['topic'] != item['topic']:
            self.warnings['conflictingRequestCopies'] += 1
            previous['conflict'] = True

    def selected_requests(self):
        # Resolve omitted request IDs only when exactly one explicit ID exists for the message.
        # Two explicitly different requests remain separate; an ambiguous copy is not charged twice.
        buckets = defaultdict(list)
        for key in self.requests:
            if key[0] == 'claude':
                buckets[key[1]].append(key)
        for keys in buckets.values():
            missing = next((key for key in keys if key[2] is None), None)
            known = [key for key in keys if key[2] is not None]
            if missing and len(known) == 1:
                # Identity completion must not replace the first source's explicit attribution.
                primary, secondary = (missing, known[0]) if keys.index(missing) < keys.index(known[0]) else (known[0], missing)
                chosen = self.requests[primary]
                self.merge_request(chosen, self.requests[secondary])
                del self.requests[missing]
                self.requests[known[0]] = chosen
            elif missing and len(known) > 1:
                self.requests[missing]['conflict'] = True
                self.warnings['ambiguousRequestIdentity'] += 1
        return [item for item in self.requests.values() if self.in_period(item['at']) and self.topic_matches(item['topic'])]

    def in_period(self, at):
        return (self.start is None or (at is not None and at >= self.start)) and (self.end is None or (at is not None and at < self.end))

    def topic_matches(self, topic):
        return self.args.topic is None or self.args.topic == topic

    def read_source(self, source):
        path = Path(source['path']).expanduser()
        if source['provider'] not in ('claude', 'codex') or source['role'] not in ROLES:
            raise ValueError('지원하지 않는 provider 또는 role')
        if source.get('topic') is not None and source['topic'] not in self.topic_ids:
            raise ValueError('mapping의 topic은 존재하는 토픽 ID여야 합니다')
        if not path.exists():
            self.warnings['missingSource'] += 1
            return
        files = [path] if path.is_file() else sorted(path.rglob('*.jsonl'))
        for file in files:
            resolved = str(file.resolve())
            if resolved in self.seen_files:
                continue
            self.seen_files.add(resolved)
            self.read_transcript(file, source)

    def read_transcript(self, path, source):
        # Stream large transcripts; only usage fields, identity and timestamps survive.
        source_id = hashlib.sha256(str(path.resolve()).encode()).hexdigest()[:20]
        self.input_paths.add(path.resolve())
        digest = hashlib.sha256()
        session = str(path.stem)
        topic = source.get('topic')
        previous_total = None
        counts_seen = 0
        observations = {}
        with path.open('rb') as stream:
            for lineno, raw in enumerate(stream, 1):
                digest.update(raw)
                try:
                    event = json.loads(raw)
                    if not isinstance(event, dict):
                        raise ValueError('not an object')
                except (ValueError, UnicodeDecodeError):
                    self.warnings['malformedLines'] += 1
                    continue
                payload = event.get('payload') or {}
                if event.get('type') == 'session_meta' and isinstance(payload, dict):
                    session = payload.get('id') or session
                    topic = topic or self.by_cwd.get(payload.get('cwd'))
                at = timestamp(event.get('timestamp'))
                if source['provider'] == 'claude':
                    message = event.get('message')
                    if event.get('type') != 'assistant' or not isinstance(message, dict) or not isinstance(message.get('usage'), dict):
                        continue
                    usage = message['usage']
                    identity = message.get('id')
                    if not identity:
                        self.warnings['missingRequestIdentity'] += 1
                        continue
                    # Request IDs can be absent in copied records. Provider message ID is stable.
                    key = ('claude', identity, event.get('requestId'))
                    old = observations.get(key, {})
                    values = dict(old.get('values', {}))
                    for raw_key, target in [('input_tokens', 'plainInputTokens'), ('cache_read_input_tokens', 'cachedInputTokens'),
                                            ('cache_creation_input_tokens', 'cacheCreationInputTokens'), ('output_tokens', 'outputTokens')]:
                        value = count(usage.get(raw_key))
                        if value is not None:
                            values[target] = max(values.get(target, 0), value)
                    if any(k in values for k in ('plainInputTokens', 'cachedInputTokens', 'cacheCreationInputTokens')):
                        values['inputTokens'] = sum(values.get(k, 0) for k in ('plainInputTokens', 'cachedInputTokens', 'cacheCreationInputTokens'))
                    times = [t for t in (old.get('at'), at) if t is not None]
                    observations[key] = {'at': min(times) if times else None, 'values': values, 'line': old.get('line', lineno),
                                         'model': message.get('model', old.get('model'))}
                elif isinstance(payload, dict) and payload.get('type') == 'token_count' and isinstance(payload.get('info'), dict):
                    info = payload['info']
                    total, usage = info.get('total_token_usage'), info.get('last_token_usage')
                    if not isinstance(total, dict) or not isinstance(usage, dict):
                        self.warnings['missingTokenFields'] += 1
                        continue
                    token_key = json.dumps(total, sort_keys=True)
                    if token_key == previous_total:
                        continue
                    previous_total = token_key
                    counts_seen += 1
                    # Index includes resets. Cumulative subtraction is incorrect across resumes.
                    key = ('codex', session, event.get('timestamp'), token_key, json.dumps(usage, sort_keys=True))
                    values = {target: count(usage.get(raw_key)) for raw_key, target in [
                        ('input_tokens', 'inputTokens'), ('cached_input_tokens', 'cachedInputTokens'), ('output_tokens', 'outputTokens')]}
                    observations[key] = {'at': at, 'values': {k: v for k, v in values.items() if v is not None}, 'line': lineno, 'model': None}
        self.sources.append({'id': source_id, 'path': str(path), 'sha256': digest.hexdigest(), 'provider': source['provider']})
        for key, observation in observations.items():
            item = {**observation, 'source': source_id, 'provider': source['provider'], 'role': source['role'], 'topic': topic, 'session': session}
            previous = self.requests.get(key)
            if previous:
                self.merge_request(previous, item)
                continue
            self.requests[key] = item

    def execution(self, item):
        if not self.in_period(item.get('endedAt')) or not self.topic_matches(item.get('topic')):
            return
        self.executions.append(item)

    def collect(self):
        # Explicit mappings take precedence over broad automatic discovery.
        for source in self.mapping.get('sources', []):
            self.read_source(source)
        for topic_id, worktree in dict.fromkeys(self.worktrees):
            name = worktree.replace('/', '-').replace(' ', '-').replace('.', '-')
            self.read_source({'path': str(self.args.claude_projects / name), 'provider': 'claude', 'role': 'runner', 'topic': topic_id})
        self.read_source({'path': str(self.args.room_home / 'codex-home/sessions'), 'provider': 'codex', 'role': 'runner'})
        for row in self.database(self.args.room_home / 'consensus-room.sqlite', 'SELECT * FROM execution_usage'):
            u = json.loads(row['usage_json'])
            end = timestamp(row['observed_at'])
            duration = count(u.get('durationMs'))
            self.execution({'id': row['execution_id'], 'role': 'runner', 'provider': row['role'], 'topic': row['topic_id'],
                'startedAt': end - duration / 1000 if end is not None and duration is not None else None,
                'endedAt': end, 'final': bool(row['final']), 'durationSeconds': duration / 1000 if duration is not None else None,
                'costUSD': count(u.get('costUSD')), 'reportedUsage': {k: u.get(k) for k in FIELDS},
                'sourceStatus': (u.get('sourceUsage') or {}).get('status'), 'phase': row['phase']})
        review_home = self.args.room_home / 'review-tools'
        for job in sorted((review_home / 'jobs').glob('*')):
            self.read_source({'path': str(job / 'codex-home/sessions'), 'provider': 'codex', 'role': 'host-review',
                              'topic': self.mapping.get('reviewJobs', {}).get(job.name)})
        for row in self.database(review_home / 'reviews.sqlite', 'SELECT * FROM runs ORDER BY rowid'):
            end = row['started'] + row['seconds'] if row.get('started') is not None and row.get('seconds') is not None else None
            usage_path = Path(row['directory']) / 'usage.json'
            usage = self.read_json(usage_path) if usage_path.exists() else None
            self.execution({'id': row['id'], 'job': row['job'], 'role': 'host-review', 'provider': 'codex',
                'topic': self.mapping.get('reviewJobs', {}).get(row['job']), 'startedAt': row.get('started'), 'endedAt': end,
                'durationSeconds': row.get('seconds'), 'final': row['status'] in ('passed', 'blocked'), 'costUSD': None,
                'sessionMode': row.get('session_mode'), 'inputBytes': row.get('input_bytes'), 'deltaBytes': row.get('delta_bytes'),
                'reportedUsage': usage, 'status': row['status']})
        admission = self.args.room_home / 'work-admission'
        for task in sorted((admission / 'tasks').glob('*')):
            self.read_source({'path': str(task / 'codex-home/sessions'), 'provider': 'codex', 'role': 'work-admission',
                              'topic': self.mapping.get('admissionTasks', {}).get(task.name)})
        for row in self.database(admission / 'admission.sqlite', 'SELECT * FROM attempts ORDER BY rowid'):
            path = admission / 'tasks' / row['task'] / 'workspace' / row['id'] / 'usage.json'
            duration = count(row.get('seconds'))
            start = count(row.get('started'))
            self.execution({'id': row['id'], 'role': 'work-admission', 'provider': 'codex',
                'topic': self.mapping.get('admissionTasks', {}).get(row['task']), 'startedAt': start,
                'endedAt': start + duration if start is not None and duration is not None else None,
                'durationSeconds': duration, 'final': row['status'] != 'running', 'costUSD': None,
                'reportedUsage': self.read_json(path) if path.exists() else None})

    def result(self):
        groups = {}
        requests = self.selected_requests()
        for item in self.executions:
            key = (item.get('topic'), item['role'], item['provider'])
            groups.setdefault(key, {'topic': key[0], 'role': key[1], 'provider': key[2], 'requests': 0,
                                    **{k: None for k in FIELDS}})
        for item in requests:
            key = (item['topic'], item['role'], item['provider'])
            group = groups.setdefault(key, {'topic': key[0], 'role': key[1], 'provider': key[2], 'requests': 0,
                                            **{k: None for k in FIELDS}})
            if item.get('conflict'):
                continue
            group['requests'] += 1
            for field in FIELDS:
                value = item['values'].get(field)
                if value is not None:
                    group[field] = (group[field] or 0) + value
        totals = {field: sum(g[field] for g in groups.values() if g[field] is not None)
                  if any(g[field] is not None for g in groups.values()) else None for field in FIELDS}
        intervals = [(e['startedAt'], e['endedAt']) for e in self.executions
                     if e.get('startedAt') is not None and e.get('endedAt') is not None and e['endedAt'] >= e['startedAt']]
        costs = [e['costUSD'] for e in self.executions if e.get('costUSD') is not None]
        for key, group in groups.items():
            executions = [e for e in self.executions if (e.get('topic'), e['role'], e['provider']) == key]
            windows = [(e['startedAt'], e['endedAt']) for e in executions if e.get('startedAt') is not None and e.get('endedAt') is not None and e['endedAt'] >= e['startedAt']]
            group['executionSecondsSum'] = sum(b - a for a, b in windows) if windows else None
            group['executionSecondsUnion'] = union_seconds(windows) if windows else None
            group['executions'] = len(executions)
            group['timingMissingExecutions'] = len(executions) - len(windows)
        return {'schemaVersion': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(),
            'period': {'from': self.args.since, 'to': self.args.until}, 'topicFilter': self.args.topic,
            'totals': totals, 'groups': list(groups.values()), 'reportedCostUSD': sum(costs) if costs else None,
            'timing': {'executionSecondsSum': sum(b - a for a, b in intervals) if intervals else None,
                       'executionSecondsUnion': union_seconds(intervals) if intervals else None,
                       'executionEnvelopeSeconds': max(b for _, b in intervals) - min(a for a, _ in intervals) if intervals else None},
            'coverage': {'requestObservations': len(requests), 'executions': len(self.executions),
                'missingRequestFields': {field: sum(field not in r['values'] for r in requests) for field in FIELDS},
                'costMissingExecutions': sum(e.get('costUSD') is None for e in self.executions),
                'mismatchedExecutions': sum(e.get('sourceStatus') == 'mismatch' for e in self.executions),
                'unassignedRequests': sum(e['topic'] is None for e in requests),
                'timingMissingExecutions': len(self.executions) - len(intervals), 'warnings': dict(self.warnings)},
            'topics': self.topics, 'sources': self.sources, 'requests': requests, 'executionObservations': self.executions,
            'limits': ['원본 요청 관측치와 실행별 보고값을 합산하지 않습니다. 청구서의 확정 비용이 아닙니다.',
                       '미배정 중재 세션과 누락 기록이 있으므로 전체 사용량을 모두 확보했다고 뜻하지 않습니다.',
                       '기간은 요청의 첫 관측 시각과 실행의 종료 시각으로 선택합니다. 기간 경계에 걸친 작업은 전체를 포함합니다.',
                       '실행 구간에는 도구·대기가 포함됩니다. 원본 JSONL 행 간격을 가동시간으로 사용하지 않습니다.']}


def markdown(report):
    def fmt(value):
        return '미확정' if value is None else f'{value:,.0f}'
    names = {t['id']: t['slug'] for t in report['topics']}
    lines = ['# 작업별 사용량 집계', '', '원본 세션에서 확인한 요청만 합산했습니다. 실행별 보고값은 중복 합산하지 않습니다.', '',
             '| 작업 | 역할 | 도구 | 입력 | 캐시 읽기 | 출력 | 기록된 실행 합계(초) |', '|---|---|---|---:|---:|---:|---:|']
    for row in report['groups']:
        name = names.get(row['topic'], '공통·미배정').replace('|', '\\|').replace('\n', ' ')
        lines.append(f"| {name} | {row['role']} | {row['provider']} | {fmt(row['inputTokens'])} | {fmt(row['cachedInputTokens'])} | {fmt(row['outputTokens'])} | {fmt(row['executionSecondsSum'])} |")
    lines += ['', f"관측 입력 합계: {fmt(report['totals']['inputTokens'])}, 출력 합계: {fmt(report['totals']['outputTokens'])} 토큰.",
              f"실행이 보고한 금액 합계: {report['reportedCostUSD'] if report['reportedCostUSD'] is not None else '미확정'} USD. 금액 없는 실행: {report['coverage']['costMissingExecutions']}건.", '',
              '## 시간과 기록 범위', '', f"실행시간 합계: {fmt(report['timing']['executionSecondsSum'])}초. 병렬 중복 제거: {fmt(report['timing']['executionSecondsUnion'])}초.",
              f"출처 불일치 실행: {report['coverage']['mismatchedExecutions']}건. 시간 미확정: {report['coverage']['timingMissingExecutions']}건.", '',
              *['- ' + text for text in report['limits']], '', '자세한 출처·해시·미배정 항목·실행별 수치는 같은 이름의 JSON에 있습니다.', '']
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--room-home', type=Path, default=Path.home() / 'Library/Application Support/ConsensusRoom')
    parser.add_argument('--claude-projects', type=Path, default=Path.home() / '.claude/projects')
    parser.add_argument('--mapping', type=Path)
    parser.add_argument('--from', dest='since')
    parser.add_argument('--to', dest='until')
    parser.add_argument('--topic')
    parser.add_argument('--output', type=Path, required=True, help='Local JSON/Markdown output stem; contains private paths')
    args = parser.parse_args()
    try:
        report = Report(args)
        report.collect()
        result = report.result()
        inputs = report.input_paths
        destinations = [args.output.with_suffix(suffix).resolve() for suffix in ('.json', '.md')]
        if any(dst in inputs or (dst.exists() and any(src.exists() and os.path.samefile(src, dst) for src in inputs)) for dst in destinations):
            raise ValueError('출력 파일이 입력 기록 또는 mapping과 겹칩니다')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        for suffix, body in [('.json', json.dumps(result, ensure_ascii=False, indent=2)), ('.md', markdown(result))]:
            path = args.output.with_suffix(suffix)
            with path.open('w', encoding='utf-8') as stream:
                path.chmod(0o600)
                stream.write(body)
        print(json.dumps({'json': str(args.output.with_suffix('.json')), 'markdown': str(args.output.with_suffix('.md'))}))
    except (ValueError, OSError, sqlite3.Error, KeyError) as exc:
        print(f'집계 실패: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
