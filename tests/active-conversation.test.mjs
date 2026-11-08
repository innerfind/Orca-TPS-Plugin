import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activeProfileUserData, readActiveConversation, selectActiveConversation } from '../src/active-conversation.mjs';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (error) { if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error; }
const sqlite = { skip: DatabaseSync ? false : 'requires node:sqlite' };
const options = () => ({ userDataPath: '/config/orca', profileId: 'local-default', observations: new Map(), platform: 'linux', now: 10_000 });
function state() {
  const s = { activeWorktreeId: 'work', activeWorkspaceKey: 'worktree:work', activeWorkspaceExecutionHostId: 'local', activeTabId: 'a',
    activeTabIdByWorktree: { work: 'a' }, activeTabTypeByWorktree: { work: 'terminal' }, activeGroupIdByWorktree: { work: 'g' },
    tabGroups: { work: [{ id: 'g', activeTabId: 'a' }] }, unifiedTabs: { work: [] }, tabsByWorktree: { work: [] },
    terminalLayoutsByTabId: {}, sleepingAgentSessionsByPaneKey: {}, terminalPtyIncarnationsByPaneKey: {} };
  for (const id of ['a', 'b']) {
    s.unifiedTabs.work.push({ id, entityId: id, groupId: 'g', contentType: 'terminal' });
    s.tabsByWorktree.work.push({ id, worktreeId: 'work', createdAt: 100, aiVaultTitle: { agent: 'codex', sessionId: `session-${id}`, title: `Title ${id}` } });
    s.terminalLayoutsByTabId[id] = { root: { type: 'leaf', leafId: 'leaf' }, activeLeafId: 'leaf', ptyIdsByLeafId: { leaf: `pty-${id}` } };
    s.sleepingAgentSessionsByPaneKey[`${id}:leaf`] = { paneKey: `${id}:leaf`, tabId: id, worktreeId: 'work', agent: 'codex', connectionId: null,
      providerSession: { id: `session-${id}`, transcriptPath: `/sessions/${id}.jsonl` }, capturedAt: 500, updatedAt: 400, state: 'working', prompt: 'DO_NOT_EXPOSE' };
    s.terminalPtyIncarnationsByPaneKey[`${id}:leaf`] = `incarnation-${id}`;
  }
  return s;
}

test('platform defaults and explicit Orca data directory are portable', () => {
  assert.equal(activeProfileUserData({ platform: 'linux', home: '/home/a', env: {} }), '/home/a/.config/orca');
  assert.equal(activeProfileUserData({ platform: 'linux', home: '/home/a', env: { XDG_CONFIG_HOME: '/xdg' } }), '/xdg/orca');
  assert.equal(activeProfileUserData({ platform: 'win32', home: 'C:\\Users\\a', env: {} }), 'C:\\Users\\a\\AppData\\Roaming\\orca');
  assert.equal(activeProfileUserData({ platform: 'darwin', home: '/Users/a', env: {} }), '/Users/a/Library/Application Support/orca');
  assert.equal(activeProfileUserData({ env: { ORCA_USER_DATA_PATH: '/custom' } }), '/custom');
});

test('same-workspace tab changes select exact session and never leak prompt', () => {
  const s = state(), o = options(), first = selectActiveConversation(s, o);
  assert.equal(first.target.sessionId, 'session-a');
  assert.equal(first.target.transcriptPath, '/sessions/a.jsonl');
  assert.ok(!JSON.stringify(first).includes('DO_NOT_EXPOSE'));
  s.tabGroups.work[0].activeTabId = 'b';
  const next = selectActiveConversation(s, o);
  assert.equal(next.target.sessionId, 'session-b');
  assert.notEqual(first.target.key, next.target.key);
});

test('focused group beats remembered terminal and ambiguity yields no target', () => {
  const s = state();
  s.tabGroups.work.push({ id: 'other', activeTabId: 'b' });
  s.unifiedTabs.work[1].groupId = 'other';
  s.activeGroupIdByWorktree.work = 'other';
  assert.equal(selectActiveConversation(s, options()).target.sessionId, 'session-b');
  delete s.activeGroupIdByWorktree.work;
  assert.equal(selectActiveConversation(s, options()).target, null);
});

test('active split leaf controls identity without treating tab title as a different pane identity', () => {
  const s = state(), a = s.terminalLayoutsByTabId.a;
  a.root = { type: 'split', first: a.root, second: { type: 'leaf', leafId: 'second' } };
  a.activeLeafId = 'second';
  s.sleepingAgentSessionsByPaneKey['a:second'] = { ...s.sleepingAgentSessionsByPaneKey['a:leaf'], paneKey: 'a:second', providerSession: { id: 'split-session' } };
  assert.equal(selectActiveConversation(s, options()).target.sessionId, 'split-session');
  a.activeLeafId = 'missing';
  assert.equal(selectActiveConversation(s, options()).target, null);
});

test('nonterminal, native chat, unknown provider and remote selections never fall back', () => {
  for (const modify of [
    s => { s.unifiedTabs.work[0].contentType = 'editor'; },
    s => { s.unifiedTabs.work[0].contentType = 'agent-session'; },
    s => { s.activeWorkspaceExecutionHostId = 'runtime:remote'; },
    s => { s.sleepingAgentSessionsByPaneKey['a:leaf'].connectionId = 'ssh'; },
    s => { s.sleepingAgentSessionsByPaneKey['a:leaf'].agent = 'unknown'; },
    s => { delete s.sleepingAgentSessionsByPaneKey['a:leaf']; },
    s => { delete s.unifiedTabs.work[0].entityId; },
    s => { s.activeWorkspaceKey = 'worktree:other'; }
  ]) { const s = state(); modify(s); assert.equal(selectActiveConversation(s, options()).target, null); }
});

test('conflicting session metadata and mismatched pane/workspace identities are rejected', () => {
  for (const modify of [
    s => { s.tabsByWorktree.work[0].aiVaultTitle.sessionId = 'new-session'; },
    s => { s.tabsByWorktree.work[0].aiVaultTitle.agent = 'claude'; },
    s => { s.sleepingAgentSessionsByPaneKey['a:leaf'].paneKey = 'b:leaf'; },
    s => { s.sleepingAgentSessionsByPaneKey['a:leaf'].worktreeId = 'other'; },
    s => { s.sleepingAgentSessionsByPaneKey['a:leaf'].providerSession.transcriptPath = '../secret.jsonl'; },
    s => { s.tabsByWorktree.work[0].createdAt = 1000; }
  ]) { const s = state(); modify(s); assert.equal(selectActiveConversation(s, options()).target, null); }
});

test('old completed mappings remain usable, but terminal reuse waits for refreshed identity', () => {
  const s = state(), o = options();
  o.now = 10_000_000;
  assert.equal(selectActiveConversation(s, o).target.sessionId, 'session-a');
  s.terminalPtyIncarnationsByPaneKey['a:leaf'] = 'new-incarnation';
  assert.equal(selectActiveConversation(s, o).target, null);
  o.now += 61_000;
  assert.equal(selectActiveConversation(s, o).target, null, 'time alone must not accept stale metadata');
  s.sleepingAgentSessionsByPaneKey['a:leaf'].capturedAt = o.now;
  assert.equal(selectActiveConversation(s, o).target.sessionId, 'session-a');
});

test('a new provider session clears terminal-reuse quarantine immediately', () => {
  const s = state(), o = options();
  selectActiveConversation(s, o);
  s.terminalPtyIncarnationsByPaneKey['a:leaf'] = 'new-incarnation';
  assert.equal(selectActiveConversation(s, o).target, null);
  s.sleepingAgentSessionsByPaneKey['a:leaf'].providerSession.id = 'new-session';
  s.tabsByWorktree.work[0].aiVaultTitle.sessionId = 'new-session';
  assert.equal(selectActiveConversation(s, o).target.sessionId, 'new-session');
});

test('same-poll incarnation and refreshed capture keep the resumed conversation visible', () => {
  const s = state(), o = options();
  assert.equal(selectActiveConversation(s, o).target.sessionId, 'session-a');
  s.terminalPtyIncarnationsByPaneKey['a:leaf'] = 'resumed-incarnation';
  s.sleepingAgentSessionsByPaneKey['a:leaf'].capturedAt = o.now - 1;
  assert.equal(selectActiveConversation(s, o).target.sessionId, 'session-a');
});

test('later capture clears quarantine even when it predates the polling clock', () => {
  const s = state(), o = options();
  selectActiveConversation(s, o);
  s.terminalPtyIncarnationsByPaneKey['a:leaf'] = 'resumed-incarnation';
  assert.equal(selectActiveConversation(s, o).target, null);
  s.sleepingAgentSessionsByPaneKey['a:leaf'].capturedAt = 500;
  assert.equal(selectActiveConversation(s, o).target, null, 'unchanged capture remains quarantined');
  s.sleepingAgentSessionsByPaneKey['a:leaf'].capturedAt = 501;
  assert.equal(selectActiveConversation(s, o).target.sessionId, 'session-a');
});

test('a capture rollback cannot weaken the next terminal-reuse baseline', () => {
  const s = state(), o = options();
  selectActiveConversation(s, o);
  s.sleepingAgentSessionsByPaneKey['a:leaf'].capturedAt = 100;
  selectActiveConversation(s, o);
  s.terminalPtyIncarnationsByPaneKey['a:leaf'] = 'resumed-incarnation';
  s.sleepingAgentSessionsByPaneKey['a:leaf'].capturedAt = 400;
  assert.equal(selectActiveConversation(s, o).target, null);
  s.sleepingAgentSessionsByPaneKey['a:leaf'].capturedAt = 501;
  assert.equal(selectActiveConversation(s, o).target.sessionId, 'session-a');
});

test('supported providers retain exact IDs and OpenCode database paths', () => {
  for (const agent of ['codex', 'claude', 'opencode', 'opencode2', 'pi', 'antigravity']) {
    const s = state();
    s.sleepingAgentSessionsByPaneKey['a:leaf'].agent = agent;
    s.tabsByWorktree.work[0].aiVaultTitle.agent = agent;
    if (agent.startsWith('opencode')) s.sleepingAgentSessionsByPaneKey['a:leaf'].providerSession.transcriptPath = '/data/opencode.db';
    const result = selectActiveConversation(s, options());
    assert.equal(result.target.provider, agent);
    if (agent.startsWith('opencode')) assert.equal(result.target.dbPath, '/data/opencode.db');
  }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-tps-active-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('orca-tps-active-test-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'profiles', 'selected'), { recursive: true });
  await writeFile(path.join(root, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: 'selected', profiles: [{ id: 'selected' }] }));
  return root;
}

test('reader sees committed WAL tab changes without writing database or reading other domains', sqlite, async t => {
  const root = await fixture(t), file = path.join(root, 'profiles', 'selected', 'profile-state.db'), db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE profile_state_documents(domain TEXT PRIMARY KEY,payload TEXT);');
    const write = db.prepare('INSERT OR REPLACE INTO profile_state_documents VALUES(?,?)'), s = state();
    write.run('workspaceSession', JSON.stringify(s));
    write.run('settings', 'DO_NOT_READ_SECRETS');
    const walBefore = await readFile(`${file}-wal`), result = await readActiveConversation({ userDataPath: root, platform: 'linux' });
    assert.equal(result.target.sessionId, 'session-a');
    assert.deepEqual(await readFile(`${file}-wal`), walBefore);
    s.tabGroups.work[0].activeTabId = 'b';
    write.run('workspaceSession', JSON.stringify(s));
    assert.equal((await readActiveConversation({ userDataPath: root, platform: 'linux' })).target.sessionId, 'session-b');
    assert.ok(result.target.key.includes('selected'));
  } finally { db.close(); }
});

test('profile index validates membership and traversal; valid backup remains usable', sqlite, async t => {
  const root = await fixture(t), index = path.join(root, 'orca-profile-index.json');
  const db = new DatabaseSync(path.join(root, 'profiles', 'selected', 'profile-state.db'));
  try { db.exec('CREATE TABLE profile_state_documents(domain TEXT PRIMARY KEY,payload TEXT)'); db.prepare('INSERT INTO profile_state_documents VALUES(?,?)').run('workspaceSession', JSON.stringify(state())); }
  finally { db.close(); }
  const good = await readFile(index);
  await writeFile(index, JSON.stringify({ activeProfileId: '../outside', profiles: [{ id: '../outside' }] }));
  assert.equal((await readActiveConversation({ userDataPath: root })).target, null);
  await writeFile(index, JSON.stringify({ activeProfileId: 'selected', profiles: [] }));
  assert.equal((await readActiveConversation({ userDataPath: root })).target, null);
  await writeFile(`${index}.bak`, good);
  assert.equal((await readActiveConversation({ userDataPath: root, platform: 'linux' })).target.sessionId, 'session-a');
});

test('malformed workspace state and missing database return empty without creating files', sqlite, async t => {
  const root = await fixture(t), file = path.join(root, 'profiles', 'selected', 'profile-state.db');
  assert.equal((await readActiveConversation({ userDataPath: root })).target, null);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const db = new DatabaseSync(file);
  try { db.exec('CREATE TABLE profile_state_documents(domain TEXT PRIMARY KEY,payload TEXT)'); db.prepare('INSERT INTO profile_state_documents VALUES(?,?)').run('workspaceSession', '{bad'); }
  finally { db.close(); }
  assert.equal((await readActiveConversation({ userDataPath: root })).target, null);
});
