import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRemoteChannelReader } from '../src/remote-channel.mjs';
import { collectRemoteChannel } from '../src/remote-collector.mjs';

test('a remote collector merges distinct sessions in the selected workspace and keeps the terminal reusable', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-remote-test-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const otherProject = path.join(root, 'other-project');
  const codexHome = path.join(home, '.codex');
  const logs = path.join(codexHome, 'sessions');
  await Promise.all([mkdir(project), mkdir(otherProject), mkdir(logs, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));

  function writeSession(id, cwd, output, completed) {
    const tokens = { output_tokens: output, input_tokens: 100 };
    const rows = [
      { type: 'session_meta', payload: { id, cwd, prompt: 'PRIVATE_CHAT_CONTENT' } },
      { timestamp: '2026-01-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
      { timestamp: completed, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: tokens } } }
    ];
    return writeFile(path.join(logs, id + '.jsonl'), rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  }
  await writeSession('remote-one', project, 200, '2026-01-01T00:00:02Z');
  await writeSession('remote-two', project, 330, '2026-01-01T00:00:03Z');
  await writeSession('other-project', otherProject, 999, '2026-01-01T00:00:04Z');

  const workspace = { id: 'host-workspace', hostId: 'runtime:primary', path: project };
  const target = { key: 'primary', executionHostId: workspace.hostId, worktreeId: 'worktree', worktreePath: project, sessions: [] };
  const actions = [];
  let child, output = '';
  const remote = createRemoteChannelReader({
    host: {
      has: () => true,
      async call(method, params) {
        actions.push(method);
        if (method === 'workspace.readContext') return { workspaceId: workspace.id };
        if (method === 'workspace.list') return { workspaces: [workspace] };
        if (method === 'terminal.create') {
          assert.equal(params.workspaceId, workspace.id);
          const command = params.command.split('"')[1];
          child = spawn(process.execPath, ['--input-type=commonjs', '-e', command], {
            cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home, ORCA_USER_DATA_PATH: home, CODEX_HOME: codexHome },
            stdio: ['pipe', 'pipe', 'ignore']
          });
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', text => { output += text; });
          return { terminalId: 'collector-terminal' };
        }
        assert.equal(params.terminalId, 'collector-terminal');
        if (method === 'terminal.read') return { lines: output.split('\n').slice(-params.maxLines) };
        if (method === 'terminal.sendText') {
          child.stdin.write(params.text + '\r');
          return { accepted: true };
        }
        if (method === 'terminal.close') {
          child.stdin.end();
          await once(child, 'exit');
          return { closed: true };
        }
        assert.fail('Unexpected host method: ' + method);
      }
    }
  }, { pollMs: 10, timeoutMs: 10_000 });
  try {
    remote.setTarget(target);
    const first = await remote.read(target);
    assert.deepEqual(first.warnings, []);
    assert.deepEqual(first.session.records.map(record => record.outputTokens), [330, 200]);
    assert.deepEqual(first.session.records.map(record => record.tokensPerSecond), [110, 100]);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_CHAT_CONTENT|remote-one|remote-two/);
    const repeated = await remote.read(target, { fresh: true });
    assert.deepEqual(repeated, first);
    assert.equal(actions.filter(method => method === 'terminal.create').length, 1);

    const wrongHost = { ...target, key: 'another-host', executionHostId: 'runtime:another' };
    remote.setTarget(wrongHost);
    assert.equal((await remote.read(wrongHost)).session, null);
    assert.equal(actions.filter(method => method === 'terminal.create').length, 1);
  } finally {
    await remote.dispose();
    if (child?.exitCode === null) child.kill();
  }
  assert.equal(actions.filter(method => method === 'terminal.close').length, 1);
});

test('the collector rejects a shell started in the wrong project directory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tps-wrong-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = path.join(root, 'separate-workspace');
  await mkdir(child);
  const result = await collectRemoteChannel({ worktreePath: child }, {
    cwd: root,
    load: () => assert.fail('The collector must not scan the wrong directory')
  });
  assert.deepEqual(result, { error: 'workspace' });
});

test('the paired Orca route requires all workspace and terminal grants', async () => {
  const target = { key: 'remote', executionHostId: 'runtime:paired', worktreeId: 'target' };
  let lookups = 0;
  const host = {
    has: () => true,
    async call(method) {
      if (method === 'workspace.readContext') return { workspaceId: 'local' };
      if (method === 'workspace.list') return { workspaces: [] };
      assert.fail('An unverified worktree must not create a terminal');
    }
  };
  async function resolveRuntime(requested) {
    assert.equal(requested, target);
    lookups++;
    return {};
  }
  for (const grantedCapabilities of [
    ['workspace:read', 'terminal:read'],
    ['workspace:read', 'terminal:read', 'terminal:send']
  ]) {
    const remote = createRemoteChannelReader({ host, grantedCapabilities }, { resolveRuntime });
    remote.setTarget(target);
    assert.equal((await remote.read(target)).session, null);
    await remote.dispose();
  }
  assert.equal(lookups, 1);
});

test('the paired route handles an unavailable native runtime without bypassing permission errors', async () => {
  const target = { key: 'remote', executionHostId: 'runtime:paired', worktreeId: 'target' };
  let lookups = 0;
  for (const code of ['runtime_unavailable', 'not_permitted']) {
    const remote = createRemoteChannelReader({
      grantedCapabilities: ['workspace:read', 'terminal:read', 'terminal:send'],
      host: {
        has: () => true,
        async call(method) {
          if (method === 'workspace.readContext') return null;
          throw Object.assign(new Error(code), { code });
        }
      }
    }, { async resolveRuntime() { lookups++; return {}; } });
    remote.setTarget(target);
    const result = await remote.read(target);
    assert.equal(result.session, null);
    assert.match(result.warnings[0], code === 'not_permitted' ? /授权/ : /工作区同步/);
    await remote.dispose();
  }
  assert.equal(lookups, 1);
});
