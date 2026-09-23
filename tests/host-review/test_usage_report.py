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
