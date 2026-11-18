import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { normalizeComparePath } from './data.mjs';
import { COLLECTOR_FILES, collectorCommand, remoteRecord } from './remote-collector.mjs';

const METHODS = ['workspace.readContext', 'workspace.list', 'terminal.create', 'terminal.sendText', 'terminal.read', 'terminal.close'];
const ROUTING_GRANTS = ['workspace:read', 'terminal:read', 'terminal:send'];
const warnings = {
  api: '当前 Orca 版本缺少远程采集接口，请更新 Orca。',
  permission: '请在 Orca 的插件设置中授权工作区和后台终端访问。',
  workspace: '暂时无法确认远程项目频道，等待 Orca 工作区同步。',
  node: '远程机器需要可用的 Node.js 22.13 或更新版本，并支持 SQLite。',
  connection: '暂时无法连接远程统计，保留该频道上次的结果。',
  read: '远程会话日志暂时无法读取，保留该频道上次的结果。'
};

class RemoteReadError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const resultError = reason => ({ session: null, warnings: [warnings[reason] ?? warnings.connection] });
const remotePath = value => normalizeComparePath(value, /^(?:[a-z]:[\\/]|\\\\)/i.test(value) ? 'win32' : 'linux');
const id = () => randomBytes(8).toString('hex');

function messageParts(requestId, request) {
  const body = gzipSync(JSON.stringify(request)).toString('base64');
  if (body.length > 96_000) throw new RemoteReadError('read');
  return ['>' + requestId, ...body.match(/.{1,3500}/g).map(part => '+' + part), '.'];
}

function responseFromLines(lines, prefix, requestId) {
  const parts = new Map();
  let total;
  for (const raw of lines) {
    const line = raw.trim();
    const header = prefix + requestId + ':';
    if (!line.startsWith(header)) continue;
    const match = /^(\d{1,3}):(\d{1,3}):([A-Za-z0-9+/=]{1,60})$/.exec(line.slice(header.length));
    if (!match) continue;
    const index = Number(match[1]), count = Number(match[2]);
    if (count < 1 || count > 800 || index >= count || (total && total !== count)) throw new RemoteReadError('read');
    total = count;
    parts.set(index, match[3]);
  }
  if (!total || parts.size !== total) return null;
  const body = Array.from({ length: total }, (_, index) => parts.get(index)).join('');
  return JSON.parse(gunzipSync(Buffer.from(body, 'base64'), { maxOutputLength: 256 * 1024 }));
}

function createRuntimeLookup() {
  const exec = promisify(execFile);
  const cliEnv = { ...process.env };
  delete cliEnv.ORCA_ENVIRONMENT;
  delete cliEnv.ORCA_PAIRING_CODE;
  const windows = process.platform === 'win32';
  if (windows) {
    // Orca's worker may omit these even though its CLI needs the profile directories.
    cliEnv.APPDATA ||= path.join(homedir(), 'AppData', 'Roaming');
    cliEnv.LOCALAPPDATA ||= path.join(homedir(), 'AppData', 'Local');
  }
  const cliName = windows ? 'orca.exe' : 'orca';
  const paths = [
    path.join(path.dirname(process.execPath), 'resources', 'bin', cliName),
    ...(windows
      ? [path.join(cliEnv.LOCALAPPDATA, 'Programs', 'orca', 'resources', 'bin', cliName)]
      : []),
    ...(process.platform === 'darwin' ? [
      path.resolve(path.dirname(process.execPath), '..', 'Resources', 'bin', cliName),
      '/Applications/Orca.app/Contents/Resources/bin/orca'
    ] : []),
    ...(process.platform === 'linux' ? [
      'orca-ide',
      path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'orca', 'linux-orca-cli-shim', 'orca')
    ] : []),
    cliName
  ];
  let executable;

  async function rpc(args, environment, signal) {
    for (const file of executable ? [executable] : paths) {
      let stdout, failure;
      try {
        const routedArgs = environment ? [...args.slice(0, 2), '--environment', environment, ...args.slice(2)] : args;
        ({ stdout } = await exec(file, [...routedArgs, '--json'], {
          signal, env: cliEnv, timeout: 12_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true
        }));
      } catch (error) {
        if (error.code === 'ENOENT') {
          if (file === executable) executable = undefined;
          continue;
        }
        stdout = error.stdout;
        failure = error;
      }
      signal?.throwIfAborted();
      if (!stdout) throw failure ?? new RemoteReadError('connection');
      const response = JSON.parse(stdout);
      if (response.ok === false) {
        const error = new RemoteReadError('connection');
        error.code = response.error?.code;
        error.operation = args.slice(0, 2).join('.');
        throw error;
      }
      if (failure) throw failure;
      executable = file;
      return response.result ?? response;
    }
    throw new RemoteReadError('api');
  }

  return async (target, signal) => {
    // The desktop's workspace API can omit paired servers. Their host IDs
    // already identify the saved Orca route, even when the desktop listing is unavailable.
    const host = target.executionHostId;
    let environment;
    if (host.startsWith('runtime:')) {
      environment = host.slice('runtime:'.length);
    } else if (host.startsWith('ssh:')) {
      const { environments } = await rpc(['environment', 'list'], null, signal);
      const matches = (environments ?? []).filter(item => item.id &&
        host === 'ssh:' + item.orcadDeployment?.sshTargetId);
      if (matches.length === 1) environment = matches[0].id;
    }
    if (!environment || !/^[\da-z][\da-z._-]*$/i.test(environment)) throw new RemoteReadError('workspace');
    const selectors = ['id:' + target.worktreeId];
    if (target.worktreePath) selectors.push('path:' + target.worktreePath);
    let workspace;
    for (const selector of selectors) {
      let result;
      try {
        result = await rpc(['worktree', 'show', '--worktree', selector], environment, signal);
      } catch (error) {
        if (error.code === 'selector_not_found') continue;
        throw error;
      }
      const row = result.worktree;
      if (row?.id && row.path && row.isArchived !== true &&
        (!target.worktreePath || remotePath(row.path) === remotePath(target.worktreePath))) {
        workspace = row;
        break;
      }
    }
    if (!workspace) throw new RemoteReadError('workspace');

    return {
      workspace,
      sendLimit: 14_000,
      async call(method, params, requestSignal) {
        switch (method) {
          case 'terminal.create': {
            const answer = await rpc(['terminal', 'create', '--worktree', 'id:' + params.workspaceId,
              '--title', params.title, '--command', params.command], environment, requestSignal);
            return { terminalId: answer.terminal?.handle };
          }
          case 'terminal.read': {
            const answer = await rpc(['terminal', 'read', '--terminal', params.terminalId,
              '--limit', String(params.maxLines)], environment, requestSignal);
            return { lines: answer.terminal?.tail };
          }
          case 'terminal.sendText':
            await rpc(['terminal', 'send', '--terminal', params.terminalId, '--text', params.text, '--enter'], environment, requestSignal);
            return { accepted: true };
          case 'terminal.close':
            return rpc(['terminal', 'close', '--terminal', params.terminalId], environment, requestSignal);
          default:
            throw new RemoteReadError('api');
        }
      }
    };
  };
}

export function createRemoteChannelReader(orca, {
  timeoutMs = 20_000, startupTimeoutMs = 45_000, pollMs = 350, now = Date.now, resolveRuntime = createRuntimeLookup()
} = {}) {
  let wanted = null, collector = null, bundle, retryAt = 0, lastFailure = 'connection';
  const pendingCreations = new Set();
  const pendingClosures = new Set();
  const call = (method, params, signal) => orca.host.call(method, params, signal ? { signal } : undefined);

  function retire(entry) {
    if (!entry) return;
    if (collector === entry) collector = null;
    entry.abort.abort();
    const terminalId = entry.terminalId;
    if (!terminalId) return;
    entry.terminalId = null;
    const timeout = AbortSignal.timeout(5000);
    const done = entry.call('terminal.close', { terminalId }, timeout)
      .catch(() => {})
      .finally(() => pendingClosures.delete(done));
    pendingClosures.add(done);
  }

  function setTarget(target) {
    const next = target?.executionHostId ? target.key : null;
    if (next === wanted) return;
    wanted = next;
    retryAt = 0;
    retire(collector);
  }

  async function waitFor(entry, signal, parse) {
    for (;;) {
      signal.throwIfAborted();
      const snapshot = await entry.call('terminal.read', { terminalId: entry.terminalId, maxLines: 900 }, signal);
      const result = parse(snapshot.lines ?? []);
      if (result) return result;
      await delay(pollMs, undefined, { signal });
    }
  }

  async function exchange(entry, request, signal) {
    const requestId = id();
    const packets = [];
    let packet = '';
    for (const part of messageParts(requestId, request)) {
      if (packet && packet.length + part.length + 1 > entry.sendLimit) {
        packets.push(packet);
        packet = '';
      }
      packet = packet ? packet + '\r' + part : part;
    }
    if (packet) packets.push(packet);
    for (const text of packets) {
      signal.throwIfAborted();
      const sent = await entry.call('terminal.sendText', { terminalId: entry.terminalId, text, enter: true }, signal);
      if (!sent?.accepted) throw new RemoteReadError('connection');
    }
    return waitFor(entry, signal, lines => responseFromLines(lines, entry.prefix, requestId));
  }

  async function start(entry, target, signal) {
    entry.stage = 'workspace';
    if (typeof orca.host?.has !== 'function' || METHODS.some(method => !orca.host.has(method))) throw new RemoteReadError('api');
    const canRoute = ROUTING_GRANTS.every(grant => orca.grantedCapabilities?.includes(grant));
    const [context, listing] = await Promise.allSettled([
      call('workspace.readContext', undefined, signal),
      call('workspace.list', undefined, signal)
    ]);
    for (const result of [context, listing]) {
      if (result.status === 'rejected' && (!canRoute || !['runtime_unavailable', 'unavailable'].includes(result.reason?.code))) {
        throw result.reason;
      }
    }
    let workspace = listing.value?.workspaces?.find(item => item.id === context.value?.workspaceId &&
      item.hostId === target.executionHostId && (!target.worktreePath || remotePath(item.path) === remotePath(target.worktreePath)));
    entry.call = call;
    entry.sendLimit = 4096;
    if (!workspace && canRoute) {
      entry.stage = 'route';
      const route = await resolveRuntime(target, signal);
      workspace = route.workspace;
      entry.call = route.call;
      entry.sendLimit = route.sendLimit ?? entry.sendLimit;
    }
    if (!workspace?.id || !workspace.path) throw new RemoteReadError('workspace');
    entry.path = workspace.path;
    const command = collectorCommand(entry.token);
    // On POSIX, replace the shell so the idle collector can close its own terminal after a disconnect.
    const startup = /^[a-z]:[\\/]|^\\\\/i.test(workspace.path) ? command : 'exec ' + command;
    entry.stage = 'terminal';
    signal.throwIfAborted();
    // Let creation return its handle even if the user switches workspaces in flight.
    // The aborted owner still needs to close exactly the terminal it opened.
    const creation = entry.call('terminal.create', { workspaceId: workspace.id, title: 'TPS 远程统计', command: startup });
    pendingCreations.add(creation);
    let terminal;
    try { terminal = await creation; }
    finally { pendingCreations.delete(creation); }
    if (!terminal?.terminalId) throw new RemoteReadError('connection');
    entry.terminalId = terminal.terminalId;
    if (signal.aborted) {
      retire(entry);
      signal.throwIfAborted();
    }
    await waitFor(entry, signal, lines => {
      if (lines.some(line => line.trim() === entry.prefix + 'node' ||
        /node.{0,14}(not found|not recognized)|command not found.{0,14}node/i.test(line))) {
        throw new RemoteReadError('node');
      }
      return lines.some(line => line.trim() === entry.prefix + 'ready');
    });

    entry.stage = 'bundle';
    bundle ??= Promise.all(COLLECTOR_FILES.map(async file => [file, await readFile(new URL(file, import.meta.url), 'utf8')]))
      .then(Object.fromEntries)
      .catch(error => { bundle = undefined; throw error; });
    const answer = await exchange(entry, { files: await bundle }, signal);
    if (answer?.installed !== true) throw new RemoteReadError('read');
  }

  async function read(target, { fresh = false } = {}) {
    if (wanted !== target.key) return resultError('workspace');
    if (!fresh && now() < retryAt) return resultError(lastFailure);
    const entry = collector ??= { token: id(), abort: new AbortController() };
    entry.prefix ??= '@TPS:' + entry.token + ':';
    const signal = AbortSignal.any([entry.abort.signal, AbortSignal.timeout(entry.terminalId ? timeoutMs : startupTimeoutMs)]);
    try {
      if (!entry.terminalId) await start(entry, target, signal);
      entry.stage = 'read';
      const answer = await exchange(entry, {
        worktreePath: entry.path,
        sessions: target.sessions,
        fresh
      }, signal);
      if (answer.error) throw new RemoteReadError(answer.error);
      if (!Array.isArray(answer.records)) return resultError('read');
      return {
        session: {
          id: 'channel:' + target.worktreeId,
          provider: 'channel',
          records: answer.records.slice(0, 100).map(remoteRecord).filter(Boolean).sort((a, b) => b.completedAt - a.completedAt)
        },
        warnings: answer.incomplete ? ['远程项目的部分会话日志暂时无法读取。'] : []
      };
    } catch (error) {
      if (collector === entry) {
        const denied = ['capability_denied', 'consent_required', 'not_permitted'].includes(error.code);
        lastFailure = denied ? 'permission' : Object.hasOwn(warnings, error.reason) ? error.reason : 'connection';
        const code = typeof error.code === 'string' && /^[a-z0-9_]+$/i.test(error.code) ? error.code : lastFailure;
        const action = error.operation ? entry.stage + '/' + error.operation : entry.stage;
        orca.log?.('远程统计读取失败（' + action + ': ' + code + '）。');
        retryAt = now() + 10_000;
        retire(entry);
        return resultError(lastFailure);
      }
      return resultError('connection');
    }
  }

  async function dispose() {
    setTarget(null);
    await Promise.allSettled(pendingCreations);
    await Promise.allSettled(pendingClosures);
  }

  return { setTarget, read, dispose };
}
