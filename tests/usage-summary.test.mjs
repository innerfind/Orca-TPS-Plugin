import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  UNIT_KEY_PREFIX, accumulateRecords, createUsageIndex, dayKeyAgo, localDayKey, realTokens, summarizeUsage, usageCutoffMs
} from '../src/usage-summary.mjs';
import { discoverUsageUnits } from '../src/data.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error; }
const sqliteTestOptions = { skip: typeof DatabaseSync === 'function' ? false : 'requires node:sqlite' };

const at = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).getTime();
const jsonl = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-tps-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('orca-tps-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('windows are local calendar days: today, the last 7 days, the last 30 days', () => {
  const now = at(2026, 11, 8, 9);
  assert.equal(localDayKey(now), '2026-11-08');
  assert.equal(dayKeyAgo(now, 0), '2026-11-08');
  assert.equal(dayKeyAgo(now, 6), '2026-11-02');
  assert.equal(dayKeyAgo(now, 29), '2026-10-10');
  assert.equal(localDayKey(usageCutoffMs(now)), dayKeyAgo(now, 364), 'the index keeps a year of days');
});

test('window totals separate today, week and month; tokens are new input plus output', () => {
  const now = at(2026, 11, 8, 9), days = {};
  accumulateRecords(days, 'claude', [
    { completedAt: at(2026, 11, 8, 8), model: 'claude-opus-5-5', freshInputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheCreationTokens: 5 },
    { completedAt: at(2026, 11, 4, 8), model: 'claude-opus-5-5', freshInputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { completedAt: at(2026, 10, 20, 8), model: '', freshInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { completedAt: at(2026, 9, 1, 8), model: 'claude-opus-5-5', freshInputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheCreationTokens: 0 }
  ]);
  accumulateRecords(days, 'codex', [
    { completedAt: at(2026, 11, 8, 7), model: 'gpt-6-astra', freshInputTokens: 200, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 }
  ]);
  const windows = summarizeUsage([days], now);
  // Real total = new input + output + cache writes + cache reads (CC Switch's definition).
  assert.equal(windows.today.requests, 2);
  assert.equal(windows.today.tokens, 1285);
  assert.equal(windows.today.cacheRead, 900);
  assert.ok(Math.abs(windows.today.cacheHitRate - 900 / 1205) < 1e-9, 'hit rate = cache reads / (fresh + writes + reads)');
  assert.equal(windows.week.requests, 3);
  assert.equal(windows.week.tokens, 1305);
  assert.equal(windows.month.requests, 4);
  assert.equal(windows.month.tokens, 1307, 'records older than 30 days stay out of every window');
  assert.equal(windows.today.rows[0].provider, 'claude', 'rows are sorted by real total');
  assert.equal(windows.month.rows.find(row => row.model === '').tokens, 2, 'missing model stays a separate empty id');
});

function fakeStorage() {
  const map = new Map();
  return {
    map,
    async keys() { return [...map.keys()]; },
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : null; },
    async set(key, value) { map.set(key, structuredClone(value)); },
    async delete(key) { map.delete(key); }
  };
}

test('index re-reads only changed units, respects the byte budget, and replaces rather than adds', async () => {
  const now = at(2026, 11, 8, 9), today = localDayKey(now);
  const storage = fakeStorage(), reads = [];
  let units = [];
  const unit = (key, stamp, tokens, { bytes = 100, mtimeMs = 1, fail = false } = {}) => ({
    key, stamp, bytes, mtimeMs,
    read: async () => {
      reads.push(key);
      if (fail) throw Object.assign(new Error('boom'), { code: 'EBROKEN' });
      return { [today]: { codex: { 'gpt-6-astra': [1, tokens, 0, 0, 0] } } };
    }
  });
  const index = createUsageIndex({ storage, discover: async () => units, now: () => now, budgetBytes: 150 });

  units = [unit('a', 's1', 100, { mtimeMs: 3 }), unit('b', 's1', 50, { mtimeMs: 2 })];
  assert.deepEqual(await index.refresh(), { pending: 1 }, 'budget spent after the newest unit');
  assert.equal(index.summary().windows.today.tokens, 100);
  assert.deepEqual(index.summary().progress, { done: 1, total: 2 });

  assert.deepEqual(await index.refresh(), { pending: 0 });
  assert.equal(index.summary().windows.today.tokens, 150);
  assert.deepEqual(reads, ['a', 'b']);

  await index.refresh();
  assert.deepEqual(reads, ['a', 'b'], 'unchanged stamps are not read again');

  units = [unit('a', 's2', 300, { mtimeMs: 4 }), unit('b', 's1', 50, { mtimeMs: 2 })];
  await index.refresh();
  assert.equal(index.summary().windows.today.tokens, 350, 'changed unit replaces its own totals');
  assert.deepEqual(reads, ['a', 'b', 'a']);

  units = [unit('a', 's2', 300, { mtimeMs: 4 })];
  await index.refresh();
  assert.equal(index.summary().windows.today.tokens, 300, 'units that left the window are dropped');
  assert.equal(storage.map.has(`${UNIT_KEY_PREFIX}b`), false);
});

test('index survives restart from storage and does not retry a broken unit until it changes', async () => {
  const now = at(2026, 11, 8, 9), today = localDayKey(now);
  const storage = fakeStorage(), reads = [];
  const good = { key: 'good', stamp: 'g1', bytes: 10, mtimeMs: 2, read: async () => ({ [today]: { pi: { '': [2, 40, 10, 0, 0] } } }) };
  const broken = {
    key: 'bad', stamp: 'b1', bytes: 10, mtimeMs: 1,
    read: async () => { reads.push('bad'); throw Object.assign(new Error('x'), { code: 'too_large' }); }
  };
  const first = createUsageIndex({ storage, discover: async () => [good, broken], now: () => now });
  await first.refresh();
  await first.refresh();
  assert.deepEqual(reads, ['bad'], 'failed unit is not retried while its stamp is unchanged');
  assert.equal(first.summary().windows.today.tokens, 50);

  const restarted = createUsageIndex({ storage, discover: async () => [good, broken], now: () => now });
  await restarted.refresh();
  assert.equal(restarted.summary().windows.today.tokens, 50, 'totals come back from storage without re-reading');
  assert.deepEqual(reads, ['bad']);
});

test('discovery counts Claude subagent calls once under the parent session and skips files older than a year', async t => {
  const root = await fixture(t), projects = path.join(root, 'projects', 'proj-a');
  const now = Date.now(), iso = offset => new Date(now - offset).toISOString();
  await mkdir(path.join(projects, 'session-1', 'subagents'), { recursive: true });
  const usage = (id, input, output) => ({ type: 'assistant', uuid: id, timestamp: iso(60_000), sessionId: 'session-1', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }, stop_reason: 'end_turn' } });
  await writeFile(path.join(projects, 'session-1.jsonl'), jsonl([usage('m1', 100, 20)]));
  await writeFile(path.join(projects, 'session-1', 'subagents', 'agent-x.jsonl'), jsonl([usage('m2', 30, 5)]));
  const old = path.join(projects, 'old-session.jsonl');
  await writeFile(old, jsonl([usage('m9', 999, 999)]));
  const longAgo = new Date(now - 400 * 86_400_000);
  await utimes(old, longAgo, longAgo);

  const units = await discoverUsageUnits(usageCutoffMs(now), { roots: { claude: [path.join(root, 'projects')] }, includeDefaults: false });
  assert.equal(units.length, 1, 'subagent files are not separate units and old files are excluded');
  const days = await units[0].read();
  const totals = Object.values(days).flatMap(byProvider => Object.values(byProvider.claude ?? {})).reduce((sum, cell) => sum + cell[1] + cell[2] + cell[3] + cell[4], 0);
  assert.equal(totals, 1155, 'parent and subagent calls both count once, cache reads included (130 + 25 + 1000)');
  assert.equal(Object.values(days).reduce((sum, byProvider) => sum + byProvider.claude['claude-opus-5-5'][0], 0), 2);
});

test('discovery turns OpenCode sessions into per-session units', sqliteTestOptions, async t => {
  const root = await fixture(t), dbPath = path.join(root, 'opencode.db');
  const now = Date.now();
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE INDEX message_session ON message(session_id);`);
  db.prepare('INSERT INTO session VALUES (?, ?)').run('ses-1', now);
  db.prepare('INSERT INTO session VALUES (?, ?)').run('ses-old', now - 400 * 86_400_000);
  const message = (id, session, input, output) => db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, session, now, JSON.stringify({
    role: 'assistant', modelID: 'glm-5.3-flash', time: { created: now - 1000, completed: now },
    tokens: { input, output, reasoning: 0, cache: { read: 800, write: 0 } }
  }));
  message('m1', 'ses-1', 200, 40);
  message('m2', 'ses-1', 10, 5);
  message('m3', 'ses-old', 1, 1);
  db.close();

  const units = await discoverUsageUnits(usageCutoffMs(now), { roots: { opencode: [dbPath] }, includeDefaults: false });
  assert.equal(units.length, 1, 'one unit per session updated inside the window');
  const days = await units[0].read();
  const cell = days[localDayKey(now)].opencode['glm-5.3-flash'];
  assert.deepEqual(cell.slice(0, 3), [2, 210, 45], 'requests, new input and output for the session');
  assert.equal(cell[3], 1600, 'cache reads are kept apart from the token total');
});

test('daily series keeps one entry per active day within the year, oldest first', async () => {
  const { dailySeries, HISTORY_DAYS } = await import('../src/usage-summary.mjs');
  const now = at(2026, 11, 8, 9), days = {};
  accumulateRecords(days, 'claude', [
    { completedAt: at(2026, 11, 8, 8), model: 'm', freshInputTokens: 10, outputTokens: 5, cacheReadTokens: 85, cacheCreationTokens: 0 },
    { completedAt: at(2026, 9, 1, 8), model: 'm', freshInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { completedAt: at(2025, 1, 1, 8), model: 'm', freshInputTokens: 999, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  ]);
  const series = dailySeries([days], now);
  assert.equal(HISTORY_DAYS, 365);
  assert.deepEqual(series.map(entry => entry.day), ['2026-09-01', '2026-11-08']);
  assert.equal(series[1].tokens, 100, 'a day total is the real total, cache reads included');
  assert.equal(series[1].requests, 1);
});

test('discovery reads Antigravity conversations with native model and cache counted in the real total', sqliteTestOptions, async t => {
  const root = await fixture(t), conversation = 'c1c2c3d4-0000-4000-8000-00000000abcd';
  const logs = path.join(root, 'brain', conversation, '.system_generated', 'logs');
  await mkdir(logs, { recursive: true });
  await mkdir(path.join(root, 'conversations'));
  const now = Date.now(), createdSec = Math.floor(now / 1000);
  await writeFile(path.join(logs, 'transcript.jsonl'), jsonl([
    { step_index: 0, type: 'USER_INPUT', source: 'USER', created_at: new Date(now).toISOString(), content: 'PRIVATE' },
    { step_index: 7, type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: new Date(now).toISOString(), input_tokens: 1000, cache_read_tokens: 5000, output_tokens: 280 }
  ]));

  // Minimal protobuf encoders for Antigravity's native step and generation metadata.
  const varint = value => { const out = []; let rest = value; while (rest >= 128) { out.push((rest % 128) | 128); rest = Math.floor(rest / 128); } out.push(rest); return Buffer.from(out); };
  const field = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
  const varField = (number, value) => Buffer.concat([varint(number * 8), varint(value)]);
  const seconds = (secs, ms) => Buffer.concat([varField(1, secs), varField(2, ms * 1_000_000)]);
  const stepMetadata = Buffer.concat([field(1, seconds(createdSec, 0)), field(20, varField(3, 3))]);
  const generation = Buffer.concat([field(1, Buffer.concat([field(21, Buffer.from('Gemini 3.8 Flash (High)')), field(11, seconds(2, 800)), field(12, seconds(0, 4))]))]);

  const db = new DatabaseSync(path.join(root, 'conversations', `${conversation}.db`));
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB);' +
    'CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
  db.prepare('INSERT INTO steps VALUES (?, 15, ?, ?)').run(7, stepMetadata, Buffer.from('PRIVATE-PAYLOAD'));
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(3, generation);
  db.close();

  const units = await discoverUsageUnits(usageCutoffMs(now), { roots: { antigravity: [path.join(root, 'brain')] }, includeDefaults: false });
  assert.equal(units.length, 1);
  const days = await units[0].read();
  const cell = days[localDayKey(now)].antigravity['gemini-3.8-flash-high'];
  assert.deepEqual(cell.slice(0, 5), [1, 1000, 280, 5000, 0]);
  assert.equal(realTokens({ freshInput: cell[1], output: cell[2], cacheWrite: cell[4], cacheRead: cell[3] }), 6280);
  assert.ok(!JSON.stringify(days).includes('PRIVATE'), 'message text and step payloads never reach the index');
});

test('streamed Codex usage equals a whole-file parse, and a file name is counted once across roots', async t => {
  const { readCodexUsageFile } = await import('../src/data.mjs');
  const { parseJsonl } = await import('../src/parsers.mjs');
  const root = await fixture(t), now = Date.now();
  const iso = offset => new Date(now - offset).toISOString();
  // Cumulative totals: each snapshot adds one request of 1000 input (800 cached) and 240 output tokens.
  const cumulative = requests => ({ input_tokens: 1000 * requests, cached_input_tokens: 800 * requests, output_tokens: 240 * requests });
  const lastRequest = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 240 };
  const rows = [
    { type: 'session_meta', payload: { id: 'codex-stream-1', cwd: '/work' } },
    { timestamp: iso(9000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: cumulative(1), last_token_usage: lastRequest } } },
    { timestamp: iso(4000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: cumulative(2), last_token_usage: lastRequest } } }
  ];
  const sessionFile = path.join(root, 'rollout-a.jsonl');
  await writeFile(sessionFile, jsonl(rows) + '{"partial":');
  const streamed = await readCodexUsageFile(sessionFile, dayKeyAgo(now, 364));
  const whole = {};
  accumulateRecords(whole, 'codex', parseJsonl(jsonl(rows), 'codex', '', { limit: Infinity }).records, { minDay: dayKeyAgo(now, 364) });
  assert.deepEqual(streamed, whole, 'the unfinished trailing line is not counted');
  assert.ok(Object.keys(streamed).length >= 1);

  const first = path.join(root, 'a'), second = path.join(root, 'b');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(path.join(first, 'rollout-dup.jsonl'), jsonl(rows));
  await writeFile(path.join(second, 'rollout-dup.jsonl'), jsonl(rows));
  const units = await discoverUsageUnits(usageCutoffMs(now), { roots: { codex: [first, second] }, includeDefaults: false });
  assert.equal(units.length, 1, 'the same file name in two roots is one unit');
});

test('large files that are still growing are re-read at most once per interval', async () => {
  const now = at(2026, 11, 8, 9), today = localDayKey(now);
  let clock = now, reads = 0;
  const storage = fakeStorage();
  let stamp = 's1';
  const big = { key: 'big', mtimeMs: now, bytes: 100 * 1024 * 1024, get stamp() { return stamp; }, read: async () => { reads += 1; return { [today]: { codex: { m: [1, 10, 0, 0, 0] } } }; } };
  const index = createUsageIndex({ storage, discover: async () => [big], now: () => clock });
  await index.refresh();
  assert.equal(reads, 1);
  stamp = 's2';
  clock += 60_000;
  await index.refresh();
  assert.equal(reads, 1, 'within the interval the previous read stays in effect');
  assert.equal(index.summary().progress.done, 1, 'a deferred large file counts as up to date');
  clock += 11 * 60_000;
  await index.refresh();
  assert.equal(reads, 2, 'after the interval the file is read again');
});
