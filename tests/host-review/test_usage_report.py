"""Public CLI contract: source observations -> attributed, non-duplicated report."""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/report-usage.py'


class UsageReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'room'
        self.home.mkdir()
        db = sqlite3.connect(self.home / 'consensus-room.sqlite')
        db.executescript('CREATE TABLE topics(id TEXT,slug TEXT,worktree_path TEXT,created_at TEXT,updated_at TEXT);'
                         'CREATE TABLE execution_usage(execution_id TEXT,topic_id TEXT,role TEXT,phase TEXT,usage_json TEXT,observed_at TEXT,final INTEGER);')
        db.execute('INSERT INTO topics VALUES(?,?,?,?,?)', ('t1', 'stage', '/fixture/work', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z'))
        db.commit()
        db.close()

    def source(self, name, events):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('\n'.join(json.dumps(e) for e in events) + '\n')
        return path

    def claude(self, output, mid='m1', **extra):
        return {'type': 'assistant', 'timestamp': '2026-01-01T00:00:01Z',
                'message': {'id': mid, 'model': 'fixture-model', 'usage': {
                    'input_tokens': 10, 'cache_read_input_tokens': 90,
                    'cache_creation_input_tokens': 0, 'output_tokens': output}}, **extra}

    def report(self, sources, *args):
        mapping = self.root / 'mapping.json'
        mapping.write_text(json.dumps({'sources': sources}))
        target = self.root / 'report'
        run = subprocess.run([sys.executable, str(SCRIPT), '--room-home', str(self.home),
            '--claude-projects', str(self.root / 'empty'), '--mapping', str(mapping),
            '--output', str(target), *args], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        return json.loads(target.with_suffix('.json').read_text())

    def test_partial_output_retransmission_and_shared_file_are_counted_once(self):
        path = self.source('claude.jsonl', [self.claude(1), self.claude(413), self.claude(413)])
        source = {'path': str(path), 'provider': 'claude', 'role': 'mediator'}
        r = self.report([source, source])
        self.assertEqual(r['totals']['inputTokens'], 100)
        self.assertEqual(r['totals']['outputTokens'], 413)
        self.assertEqual(r['totals']['cachedInputTokens'], 90)
        self.assertIsNone(r['reportedCostUSD'])
        self.assertEqual(r['groups'][0]['topic'], None)

    def test_parent_aggregate_is_not_added_to_child_requests(self):
        self.source('parent/subagents/child.jsonl', [self.claude(20, 'child')])
        self.source('parent/main.jsonl', [self.claude(10),
            {'type': 'result', 'total_cost_usd': 1.2, 'usage': {'input_tokens': 200, 'output_tokens': 30}}])
        r = self.report([{'path': str(self.root / 'parent'), 'provider': 'claude', 'role': 'mediator'}])
        self.assertEqual(r['totals']['outputTokens'], 30)
        self.assertEqual(r['totals']['inputTokens'], 200)
        # A transcript result cost has no known execution/child boundary; do not add it.
        self.assertIsNone(r['reportedCostUSD'])

    def test_copied_partial_response_is_completed_and_distinct_request_is_preserved(self):
        a = self.source('a.jsonl', [self.claude(1, requestId='one')])
        b = self.source('b.jsonl', [self.claude(413, requestId='one'), self.claude(5, requestId='two')])
        r = self.report([{'path': str(p), 'provider': 'claude', 'role': 'mediator'} for p in [a, b]])
        self.assertEqual(r['totals']['inputTokens'], 200)
        self.assertEqual(r['totals']['outputTokens'], 418)

    def test_missing_fields_are_not_reported_as_zero(self):
        e = self.claude(1)
        e['message']['usage'] = {'output_tokens': 1}
        path = self.source('partial.jsonl', [e])
        r = self.report([{'path': str(path), 'provider': 'claude', 'role': 'mediator'}])
        self.assertIsNone(r['totals']['inputTokens'])
        self.assertEqual(r['coverage']['missingRequestFields']['inputTokens'], 1)

    def test_missing_request_id_copy_is_joined_by_message(self):
        a = self.source('a.jsonl', [self.claude(1, requestId='one')])
        b = self.source('b.jsonl', [self.claude(413)])
        r = self.report([{'path': str(p), 'provider': 'claude', 'role': 'mediator'} for p in [a, b]])
        self.assertEqual(r['totals']['inputTokens'], 100)
        self.assertEqual(r['totals']['outputTokens'], 413)

    def test_missing_id_merge_preserves_explicit_mapping_over_automatic_role(self):
        mapped = self.source('mapped.jsonl', [self.claude(1)])
        self.source('empty/-fixture-work/automatic.jsonl', [self.claude(413, requestId='one')])
        r = self.report([{'path': str(mapped), 'provider': 'claude', 'role': 'pre-audit', 'topic': 't1'}])
        self.assertEqual(len(r['groups']), 1)
        self.assertEqual(r['groups'][0]['role'], 'pre-audit')
        self.assertEqual(r['groups'][0]['outputTokens'], 413)
        self.assertEqual(r['sources'][0]['id'], r['requests'][0]['source'])

    def test_ambiguous_missing_request_id_is_not_charged_again(self):
        path = self.source('ambiguous.jsonl', [self.claude(10, requestId='one'),
            self.claude(20, requestId='two'), self.claude(20)])
        r = self.report([{'path': str(path), 'provider': 'claude', 'role': 'mediator'}])
        self.assertEqual(r['totals']['inputTokens'], 200)
        self.assertEqual(r['totals']['outputTokens'], 30)
        self.assertEqual(r['coverage']['warnings']['ambiguousRequestIdentity'], 1)

    def test_period_filter_follows_first_observation_across_files(self):
        a = self.source('a.jsonl', [self.claude(1, requestId='one')])
        late = self.claude(413, requestId='one')
        late['timestamp'] = '2026-01-03T00:00:00Z'
        b = self.source('b.jsonl', [late])
        for files in ([a, b], [b, a]):
            with self.subTest(order=[p.name for p in files]):
                r = self.report([{'path': str(p), 'provider': 'claude', 'role': 'mediator'} for p in files],
                                '--to', '2026-01-02T00:00:00Z')
                self.assertEqual(r['totals']['outputTokens'], 413)
                r = self.report([{'path': str(p), 'provider': 'claude', 'role': 'mediator'} for p in files],
                                '--from', '2026-01-02T00:00:00Z')
                self.assertIsNone(r['totals']['outputTokens'])

    def test_previous_worktree_keeps_tokens_in_same_topic(self):
        db = sqlite3.connect(self.home / 'consensus-room.sqlite')
        db.execute('CREATE TABLE timeline_events(topic_id TEXT, kind TEXT, payload_json TEXT)')
        db.execute('INSERT INTO timeline_events VALUES(?,?,?)', ('t1', 'scope_change', json.dumps({'previousWorktreePath': '/fixture/old'})))
        db.commit(); db.close()
        self.source('empty/-fixture-old/old.jsonl', [self.claude(15)])
        r = self.report([], '--topic', 't1')
        self.assertEqual(r['totals']['outputTokens'], 15)
        self.assertEqual(r['groups'][0]['topic'], 't1')

    def test_receipt_input_cannot_be_replaced_by_report(self):
        receipt = self.source('receipt/usage.json', [])
        receipt.write_text('{"reported": []}')
        (self.home / 'review-tools').mkdir(exist_ok=True)
        db = sqlite3.connect(self.home / 'review-tools/reviews.sqlite')
        db.execute('CREATE TABLE runs(id TEXT,job TEXT,status TEXT,directory TEXT,started REAL,seconds REAL)')
        db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?)', ('r1', 'j1', 'passed', str(receipt.parent), 1, 1))
        db.commit(); db.close()
        original = receipt.read_bytes()
        run = subprocess.run([sys.executable, str(SCRIPT), '--room-home', str(self.home),
            '--claude-projects', str(self.root / 'empty'), '--output', str(receipt.with_suffix(''))], capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(receipt.read_bytes(), original)

    def test_codex_repeated_total_and_reset_use_last_usage_not_cumulative_sum(self):
        def count(total, last):
            return {'type': 'event_msg', 'timestamp': '2026-01-01T00:01:00Z', 'payload': {
                'type': 'token_count', 'info': {'total_token_usage': total, 'last_token_usage': last}}}
        a = {'input_tokens': 100, 'cached_input_tokens': 80, 'output_tokens': 10}
        b = {'input_tokens': 200, 'cached_input_tokens': 160, 'output_tokens': 20}
        c = {'input_tokens': 50, 'cached_input_tokens': 40, 'output_tokens': 5}
        path = self.source('codex.jsonl', [{'type': 'session_meta', 'payload': {'id': 'session', 'cwd': '/fixture/work'}},
            count(a, a), count(a, a), count(b, a), count(c, c)])
        r = self.report([{'path': str(path), 'provider': 'codex', 'role': 'runner'}])
        self.assertEqual(r['totals']['inputTokens'], 250)
        self.assertEqual(r['totals']['outputTokens'], 25)
        self.assertEqual(r['groups'][0]['topic'], 't1')

    def test_admission_discovers_legacy_and_runtime_sessions_without_counting_copies_twice(self):
        def events(session, usage):
            return [{'type': 'session_meta', 'payload': {'id': session, 'cwd': '/fixture/work'}},
                    {'type': 'event_msg', 'timestamp': '2026-01-01T00:01:00Z', 'payload': {
                        'type': 'token_count', 'info': {'total_token_usage': usage, 'last_token_usage': usage}}}]
        prefix = 'room/work-admission/tasks/task-1/'
        old = events('old', {'input_tokens': 100, 'cached_input_tokens': 80, 'output_tokens': 10})
        self.source(prefix + 'codex-home/sessions/old.jsonl', old)
        # An older session may also be preserved in a runtime home; it remains one request.
        self.source(prefix + 'runtime/codex-home/isolated/home-a/sessions/copied.jsonl', old)
        new = self.source(prefix + 'runtime/codex-home/isolated/home-b/sessions/new.jsonl',
                          events('new', {'input_tokens': 50, 'cached_input_tokens': 40, 'output_tokens': 5}))
        r = self.report([])
        self.assertEqual(r['totals']['inputTokens'], 150)
        self.assertEqual(r['totals']['outputTokens'], 15)
        self.assertEqual(r['totals']['cachedInputTokens'], 120)
        self.assertEqual(len(r['groups']), 1)
        self.assertEqual((r['groups'][0]['role'], r['groups'][0]['topic'], r['groups'][0]['requests']),
                         ('work-admission', 't1', 2))
        # Explicit attribution still takes precedence when the same file is discovered automatically.
        mapped = self.report([{'path': str(new), 'provider': 'codex', 'role': 'pre-audit', 'topic': 't1'}])
        self.assertEqual(mapped['totals'], r['totals'])
        self.assertEqual(next(g for g in mapped['groups'] if g['role'] == 'pre-audit')['outputTokens'], 5)

    def test_host_review_runtime_run_counts_its_native_session_once(self):
        # E2e-2: the runtime keeps the job's Codex home as the session home. Its event log and raw usage receipt
        # are execution observations, not extra requests; the runtime data folder holds no sessions.
        usage = {'input_tokens': 120, 'cached_input_tokens': 100, 'output_tokens': 12}
        prefix = 'room/review-tools/jobs/job-1/'
        self.source(prefix + 'codex-home/sessions/rollout-s1.jsonl', [
            {'type': 'session_meta', 'payload': {'id': 's1', 'cwd': '/fixture/review/workspace'}},
            {'type': 'event_msg', 'timestamp': '2026-01-01T00:01:00Z', 'payload': {
                'type': 'token_count', 'info': {'total_token_usage': usage, 'last_token_usage': usage}}}])
        self.source(prefix + 'runtime/output-schemas/schema.json', [{'type': 'object'}])
        run = self.root / prefix / 'workspace/runs/r1'
        self.source(prefix + 'workspace/runs/r1/runtime.jsonl', [
            {'type': 'spawn', 'pid': 4242, 'at': 1000}, {'type': 'session', 'sessionId': 's1'},
            {'type': 'provider-usage', 'usage': usage}])
        receipt = {'model': 'gpt-6-astra', 'effort': 'xhigh', 'reported': [usage]}
        (run / 'usage.json').write_text(json.dumps(receipt))
        with sqlite3.connect(self.home / 'review-tools/reviews.sqlite') as db:
            db.execute('CREATE TABLE runs(id TEXT,job TEXT,status TEXT,directory TEXT,started REAL,seconds REAL,'
                       'session_mode TEXT,input_bytes INTEGER,delta_bytes INTEGER,pid INTEGER,provider_pid INTEGER)')
            db.execute('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?)', ('r1', 'job-1', 'passed', str(run), 1, 2, 'create', 30, None, 77, 4242))
        r = self.report([])
        self.assertEqual((r['totals']['inputTokens'], r['totals']['outputTokens'], r['totals']['cachedInputTokens']), (120, 12, 100))
        self.assertEqual([(g['role'], g['requests']) for g in r['groups']], [('host-review', 1)])
        [observation] = r['executionObservations']
        self.assertEqual((observation['role'], observation['reportedUsage'], observation['inputBytes']), ('host-review', receipt, 30))

    def test_repair_sessions_are_requests_once_and_attempt_ledger_stays_an_execution_observation(self):
        # E2e-3: each repair attempt runs in its own runtime home; the attempt ledger separates attempts from model calls.
        usage = {'input_tokens': 100, 'cached_input_tokens': 80, 'output_tokens': 10}
        session = [{'type': 'session_meta', 'payload': {'id': 'repair-1', 'cwd': '/fixture/repair/source'}},
                   {'type': 'event_msg', 'timestamp': '2026-01-01T00:01:00Z', 'payload': {
                       'type': 'token_count', 'info': {'total_token_usage': usage, 'last_token_usage': usage}}}]
        prefix = 'room/work-admission/repairs/job-1/'
        self.source(prefix + '1/runtime/codex-home/isolated/home-a/sessions/rollout-repair-1.jsonl', session)
        self.source(prefix + '1/codex-home/sessions/copied.jsonl', session)  # an older copy of the same session
        first = self.root / prefix / '1'
        (first / 'usage.json').write_text(json.dumps(usage))
        second = self.root / prefix / '2'
        second.mkdir(parents=True)
        (second / 'usage.json').write_text('null')
        with sqlite3.connect(self.home / 'work-admission/admission.sqlite') as db:
            db.execute('CREATE TABLE attempts(id TEXT,task TEXT,status TEXT,started REAL,seconds REAL)')
            db.execute('CREATE TABLE repair_rounds(job TEXT,round INTEGER,directory TEXT,status TEXT,started REAL,seconds REAL,'
                       'provider TEXT,model TEXT,effort TEXT,provider_pid INTEGER,spawned REAL,thread TEXT)')
            db.execute('INSERT INTO repair_rounds VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       ('job-1', 1, str(first), 'completed', 10, 5, 'codex', 'gpt-6-astra', 'medium', 77, 11, 'repair-1'))
            # A refused attempt: the runtime stopped it before the provider started.
            db.execute('INSERT INTO repair_rounds VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       ('job-1', 2, str(second), 'failed', 20, 1, 'codex', 'gpt-6-astra', 'medium', None, None, None))
        r = self.report([])
        self.assertEqual((r['totals']['inputTokens'], r['totals']['outputTokens'], r['totals']['cachedInputTokens']), (100, 10, 80))
        self.assertEqual([(g['role'], g['provider'], g['requests'], g['executions']) for g in r['groups']], [('repair', 'codex', 1, 2)])
        observed = {e['id']: e for e in r['executionObservations']}
        self.assertEqual((observed['job-1/1']['reportedUsage'], observed['job-1/1']['modelCall']), (usage, True))
        self.assertEqual((observed['job-1/2']['reportedUsage'], observed['job-1/2']['modelCall']), (None, False))
        self.assertEqual((observed['job-1/1']['startedAt'], observed['job-1/1']['endedAt']), (10, 15))

    def test_repair_sessions_are_found_when_the_attempt_ledger_does_not_exist_yet(self):
        usage = {'input_tokens': 7, 'output_tokens': 1}
        self.source('room/work-admission/repairs/job-1/1/runtime/codex-home/isolated/home-a/sessions/rollout.jsonl', [
            {'type': 'session_meta', 'payload': {'id': 'repair-2'}},
            {'type': 'event_msg', 'timestamp': '2026-01-01T00:01:00Z', 'payload': {
                'type': 'token_count', 'info': {'total_token_usage': usage, 'last_token_usage': usage}}}])
        with sqlite3.connect(self.home / 'work-admission/admission.sqlite') as db:
            db.execute('CREATE TABLE attempts(id TEXT,task TEXT,status TEXT,started REAL,seconds REAL)')
        r = self.report([])
        self.assertEqual((r['totals']['inputTokens'], r['totals']['outputTokens']), (7, 1))
        self.assertEqual(r['executionObservations'], [])

    def test_admission_runtime_missing_usage_stays_null_and_execution_receipt_is_not_added(self):
        prefix = 'room/work-admission/tasks/task-1/'
        self.source(prefix + 'runtime/codex-home/isolated/home-a/sessions/partial.jsonl', [
            {'type': 'session_meta', 'payload': {'id': 'partial'}},
            {'type': 'event_msg', 'timestamp': '2026-01-01T00:01:00Z', 'payload': {
                'type': 'token_count', 'info': {
                    'total_token_usage': {'output_tokens': 3}, 'last_token_usage': {'output_tokens': 3}}}}])
        usage = [{'inputTokens': 9000, 'outputTokens': 900, 'stage': 'final'}]
        path = self.source(prefix + 'workspace/attempt-1/usage.json', [])
        path.write_text(json.dumps(usage))
        with sqlite3.connect(self.home / 'work-admission/admission.sqlite') as db:
            db.execute('CREATE TABLE attempts(id TEXT,task TEXT,status TEXT,started REAL,seconds REAL)')
            db.execute('INSERT INTO attempts VALUES(?,?,?,?,?)', ('attempt-1', 'task-1', 'done', 1, 2))
        r = self.report([])
        self.assertEqual(r['totals']['outputTokens'], 3)
        self.assertIsNone(r['totals']['inputTokens'])
        self.assertIsNone(r['totals']['cachedInputTokens'])
        self.assertIsNone(r['reportedCostUSD'])
        self.assertEqual(r['executionObservations'][0]['reportedUsage'], usage)
        self.assertEqual(r['groups'][0]['requests'], 1)
        self.assertEqual(r['coverage']['missingRequestFields']['inputTokens'], 1)
        self.assertEqual(r['coverage']['costMissingExecutions'], 1)

    def test_period_filter_keeps_output_completion_and_topic_filter_excludes_unassigned(self):
        path = self.source('claude.jsonl', [self.claude(1), self.claude(413)])
        r = self.report([{'path': str(path), 'provider': 'claude', 'role': 'runner', 'topic': 't1'}],
                        '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-02T00:00:00Z', '--topic', 't1')
        self.assertEqual(r['totals']['outputTokens'], 413)

    def test_execution_intervals_cost_and_mismatch_are_separate_from_raw_tokens(self):
        db = sqlite3.connect(self.home / 'consensus-room.sqlite')
        for key, end, cost in [('one', '2026-01-01T00:02:00Z', 1), ('two', '2026-01-01T00:03:00Z', None)]:
            usage = {'durationMs': 120000, 'inputTokens': 9000, 'outputTokens': 900,
                     'costUSD': cost, 'sourceUsage': {'status': 'mismatch'}}
            db.execute('INSERT INTO execution_usage VALUES(?,?,?,?,?,?,?)', (key, 't1', 'claude', 'work', json.dumps(usage), end, 1))
        db.commit(); db.close()
        r = self.report([])
        self.assertEqual(r['totals']['inputTokens'], None)
        self.assertEqual(r['timing']['executionSecondsSum'], 240)
        self.assertEqual(r['timing']['executionSecondsUnion'], 180)
        self.assertEqual(r['reportedCostUSD'], 1)
        self.assertEqual(r['coverage']['costMissingExecutions'], 1)
        self.assertEqual(r['coverage']['mismatchedExecutions'], 2)
        self.assertEqual(len(r['groups']), 1)
        self.assertEqual(r['groups'][0]['executionSecondsSum'], 240)
        self.assertIsNone(r['groups'][0]['inputTokens'])


if __name__ == '__main__':
    unittest.main()
