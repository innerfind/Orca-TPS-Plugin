import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createLeaderboardServer } from '../server/app.mjs';
import { openLeaderboardStore } from '../server/store.mjs';
import { startLeaderboard } from '../src/leaderboard.mjs';
import { discoverUsageUnits } from '../src/data.mjs';
import { createUsageIndex, leaderboardDay, leaderboardDayStart } from '../src/usage-summary.mjs';

const ORIGIN = 'http://127.0.0.1:8787';
const TODAY = '2026-11-18';
const START = leaderboardDayStart(TODAY);

async function fixture(t, names = ['alice', 'bob']) {
  const store = openLeaderboardStore(':memory:');
  let clock = START + 3600_000, count = 0;
  const devices = new Map();
  const users = { alice: 1, bob: 2, admin: 3, visitor: 4 };
  async function mockGitHub(url, options) {
    const route = new URL(url).pathname;
    let data;
    if (route === '/login/device/code') {
      const device_code = String(++count);
      devices.set(device_code, names.shift());
      data = { device_code, user_code: 'ORCA-' + device_code.padStart(4, '0'), expires_in: 900, interval: 1 };
    } else if (route === '/login/oauth/access_token') {
      const user = options.body.get('code') || devices.get(options.body.get('device_code'));
      data = users[user] ? { access_token: user } : { error: 'authorization_pending' };
    } else if (route === '/user') {
      const name = options.headers.Authorization.slice(7);
      data = { login: name, id: users[name] };
    } else if (route === '/user/emails') {
      data = [{ email: 'staff@example.test', verified: options.headers.Authorization === 'Bearer admin' }];
    } else {
      throw new Error('Unexpected GitHub route: ' + route);
    }
    return Response.json(data);
  }
  const server = createLeaderboardServer({
    store, baseUrl: ORIGIN, clientId: 'example-client', clientSecret: 'example-secret',
    adminEmail: 'staff@example.test', maxTokens: 1_000_000, fetcher: mockGitHub, now: () => clock,
    log: message => t.diagnostic(message)
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const call = (route, options) => fetch(endpoint + route, { redirect: 'manual', ...options });
  const advance = ms => { clock += ms; };
  const bearer = token => ({ Authorization: 'Bearer ' + token });
  const get = (token, route = '/api/today') => call(route, { headers: bearer(token) });
  const post = (route, body, headers = {}) => call(route, {
    method: 'POST', body: JSON.stringify(body), headers: { ...headers, 'Content-Type': 'application/json' }
  });

  async function login() {
    const challenge = await (await post('/api/auth/device/start', {})).json();
    const poll = () => post('/api/auth/device/poll', { ticket: challenge.ticket });
    assert.equal((await poll()).status, 202);
    advance(1001);
    const response = await poll();
    assert.equal(response.status, 200);
    return (await response.json()).token;
  }
  const submit = (token, tokens, requestId = randomUUID(), day = leaderboardDay(clock)) => post(
    '/api/today/submit', { day, tokens }, { ...bearer(token), 'Idempotency-Key': requestId }
  );

  async function websiteLogin(githubName) {
    const start = await call('/auth/github/start');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cookie = start.headers.getSetCookie()[0].split(';')[0];
    const complete = await call('/auth/github/callback?' + new URLSearchParams({ code: githubName, state }), { headers: { cookie } });
    return {
      redirect: complete.headers.get('location'),
      cookie: complete.headers.getSetCookie().find(value => value.startsWith('orca_admin='))?.split(';')[0]
    };
  }
  async function authorizePlugin(link, githubName) {
    const linkUrl = new URL(link);
    assert.equal(linkUrl.origin, endpoint);
    const start = await call(linkUrl.pathname + linkUrl.search);
    assert.equal(start.status, 303);
    const target = new URL(start.headers.get('location'));
    assert.equal(target.origin, 'https://github.com');
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(target.searchParams.get('redirect_uri'), ORIGIN + '/auth/github/callback');
    const cookie = start.headers.getSetCookie()[0].split(';')[0];
    const callback = '/auth/github/callback?' + new URLSearchParams({ code: githubName, state: target.searchParams.get('state') });
    assert.equal((await call(callback)).status, 400);
    const result = await call(callback, { headers: { cookie } });
    assert.equal(result.status, 200);
    assert.match(await result.text(), /GitHub 授权成功/);
    const wrongPoll = await post('/api/auth/plugin/poll', { verifier: 'A'.repeat(43) });
    assert.equal(wrongPoll.status, 202);
    assert.equal((await wrongPoll.json()).token, undefined);
  }
  const form = (route, cookie, fields, origin = ORIGIN) => call(route, {
    method: 'POST', headers: { cookie, origin }, body: new URLSearchParams(fields)
  });
  return { call, advance, login, get, submit, websiteLogin, authorizePlugin, form, endpoint, clock: () => clock };
}

test('everyone can view today’s ranking, while submissions require login and exclude banned accounts', async t => {
  const api = await fixture(t);
  const guest = await api.call('/api/today');
  assert.equal(guest.status, 200);
  assert.equal((await guest.json()).authenticated, false);
  assert.equal((await api.submit('', 300)).status, 401);
  const alice = await api.login(), bob = await api.login();
  const outcomes = await Promise.all([api.submit(alice, 300), api.submit(alice, 300)]);
  assert.deepEqual(outcomes.map(result => result.status).sort(), [201, 409]);
  assert.equal((await api.submit(bob, 500)).status, 201);
  const board = await (await api.get(alice)).json();
  assert.deepEqual(board.rows.map(row => [row.username, row.tokens, row.rank]), [['bob', 500, 1], ['alice', 300, 2]]);
  assert.equal(board.rank, 2);
  assert.equal(board.rows[1].mine, true);
  const publicBoard = await (await api.call('/api/today')).json();
  assert.equal(publicBoard.authenticated, false);
  assert.equal(publicBoard.submittedAt, undefined);
  assert.deepEqual(publicBoard.rows.map(row => row.username), ['bob', 'alice']);

  assert.equal((await api.websiteLogin('visitor')).redirect, '/admin?feedback=forbidden');
  const admin = await api.websiteLogin('admin');
  assert.equal(admin.redirect, '/admin');
  const dashboard = await api.call('/admin', { headers: { cookie: admin.cookie } });
  assert.match(await dashboard.text(), /alice/);
  assert.equal((await api.form('/admin/ban', admin.cookie, { account: '1', ban: '1' }, 'https://other.example')).status, 403);
  assert.equal((await api.form('/admin/ban', admin.cookie, { account: '1', ban: '1' })).status, 303);
  const bannedView = await api.get(alice);
  assert.equal(bannedView.status, 200);
  assert.equal((await bannedView.json()).banned, true);
  assert.equal((await api.get(alice, '/api/today/status')).status, 403);
  assert.equal((await api.submit(alice, 450)).status, 403);
  assert.equal((await api.form('/admin/ban', admin.cookie, { account: '1', ban: '0' })).status, 303);
  assert.equal((await api.get(alice)).status, 200);
  assert.equal((await api.form('/admin/delete', admin.cookie, { account: '1', day: TODAY })).status, 303);
  const afterDelete = await (await api.get(alice)).json();
  assert.deepEqual(afterDelete.rows.map(row => row.username), ['bob']);
  assert.equal(afterDelete.submitted, true);
  assert.equal((await api.submit(alice, 901)).status, 409);

  await api.form('/admin/clear', admin.cookie, { day: TODAY, scope: 'all', confirm: 'no' });
  assert.equal((await (await api.get(bob)).json()).rows.length, 1);
  await api.form('/admin/clear', admin.cookie, { day: TODAY, scope: 'all', confirm: '清空' });
  assert.equal((await (await api.get(bob)).json()).rows.length, 0);
  assert.equal((await api.submit(bob, 700)).status, 409);
});

test('the fifth error locks for the entire Beijing day, while retransmissions and errors outside the window do not count', async t => {
  const api = await fixture(t);
  const alice = await api.login();
  assert.equal((await api.submit(alice, -1)).status, 400);
  api.advance(10 * 60 * 1000);
  const first = randomUUID();
  for (let index = 0; index < 8; index++) assert.equal((await api.submit(alice, -1, first)).status, 400);
  for (let index = 0; index < 3; index++) assert.equal((await api.submit(alice, -1)).status, 400);
  const locked = await api.submit(alice, -1);
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).lockedUntil, START + 86_400_000);
  assert.equal((await api.get(alice)).status, 200);
  api.advance(3600_000);
  assert.equal((await api.submit(alice, 25)).status, 429);
  api.advance(START + 86_400_000 - api.clock());
  assert.equal((await api.submit(alice, 25)).status, 201);
});

test('reopening the database keeps the score and the daily lock', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-rank-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'leaderboard.sqlite');
  const store = openLeaderboardStore(filename);
  store.upsertAccount({ id: 1, login: 'alice' });
  const submit = tokens => store.submit(1, { day: TODAY, tokens, requestId: randomUUID(), fingerprint: 'test' }, START, 5);
  assert.equal(submit(5), 'accepted');
  for (let index = 0; index < 5; index++) submit(5);
  store.close();
  const reopened = openLeaderboardStore(filename);
  try {
    assert.equal(reopened.status(1, START).lockedUntil, START + 86_400_000);
    assert.equal(reopened.ranking(1, START).rows[0].tokens, 5);
  } finally { reopened.close(); }
});

test('the plugin worker signs in through the browser, keeps its session after restart, and submits once', async t => {
  const api = await fixture(t);
  const storage = new Map(), secrets = new Map(), handlers = new Map();
  const orca = {
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    host: { has: () => true, call: async (method, { key, value }) => {
      if (method === 'secrets.get') return { value: secrets.get(key) };
      if (method === 'secrets.set') return secrets.set(key, value);
      if (method === 'secrets.delete') return secrets.delete(key);
    } },
    grantedCapabilities: ['secrets:own'],
    panels: { handle: (name, run) => { handlers.set(name, run); return { dispose: () => handlers.delete(name) }; } }
  };
  let tokens = 600;
  const launch = () => startLeaderboard(orca, {
    endpoint: api.endpoint, now: () => new Date(api.clock()),
    readUsage: async () => ({ day: TODAY, tokens, ready: true })
  });
  let stop = launch();
  t.after(() => stop());
  const run = (action, fields = {}) => handlers.get('tps.leaderboard')({ action, ...fields });
  const initial = await run('state');
  assert.equal(initial.board.authenticated, false);
  assert.equal((await run('submit', { day: TODAY, tokens })).code, 'login_required');
  assert.deepEqual(JSON.parse(JSON.stringify(initial)), initial);
  const login = await run('login');
  assert.equal((await run('poll')).code, 'pending');
  await api.authorizePlugin(login.loginUrl, 'alice');
  const signedIn = await run('poll');
  assert.equal(signedIn.code, 'signed_in');
  assert.equal(signedIn.board.username, 'alice');
  assert.equal(signedIn.token, undefined);
  stop();
  stop = launch();
  assert.equal((await run('state')).board.username, 'alice');
  tokens = 700;
  assert.equal((await run('submit', { day: TODAY, tokens: 600 })).code, 'usage_changed');
  const submitted = await run('submit', { day: TODAY, tokens: 700 });
  assert.equal(submitted.code, 'accepted');
  assert.equal(submitted.board.rows[0].tokens, 700);
  const viewerToken = secrets.get('leaderboard-session');
  const clock = new Date(api.clock());
  const localTime = [clock.getHours(), clock.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
  await run('schedule', { time: localTime });
  for (let tries = 0; tries < 25 && !(await run('state')).lastAutomaticResult; tries++) await delay(10);
  assert.equal((await run('state')).lastAutomaticResult.code, 'duplicate');
  assert.equal((await run('logout')).board.authenticated, false);
  assert.equal(secrets.size, 0);
  assert.equal((await api.get(viewerToken, '/api/today/status')).status, 401);

  await api.authorizePlugin((await run('login')).loginUrl, 'bob');
  assert.equal((await run('poll')).board.username, 'bob');
  await run('schedule', { time: localTime });
  for (let tries = 0; tries < 25 && !(await run('state')).lastAutomaticResult; tries++) await delay(10);
  const automatic = await run('state');
  assert.equal(automatic.lastAutomaticResult.code, 'accepted');
  assert.equal(automatic.board.rows.find(row => row.mine).tokens, 700);
});

test('usage discovery separates requests on either side of Beijing midnight from one source file', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-rank-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const day = leaderboardDay(Date.now()), start = leaderboardDayStart(day);
  const message = (at, output) => ({
    type: 'message', timestamp: new Date(at).toISOString(),
    message: { role: 'assistant', provider: 'test', model: 'test', timestamp: at - 1000,
      usage: { input: 5, output, cacheRead: 2, cacheWrite: 3 } }
  });
  await writeFile(path.join(dir, 'current.jsonl'), [
    { type: 'session', id: 'current', cwd: dir },
    message(start - 1, 5), message(start, 40)
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const values = new Map();
  const index = createUsageIndex({
    leaderboard: true, now: () => Date.now(),
    storage: { keys: async () => [...values.keys()], get: async key => values.get(key),
      set: async (key, value) => values.set(key, value), delete: async key => values.delete(key) },
    discover: (cutoff, rankDay) => discoverUsageUnits(cutoff, { roots: { pi: [dir] }, includeDefaults: false, rankDay })
  });
  assert.equal(index.leaderboardUsage().ready, false);
  await index.refresh();
  const current = index.leaderboardUsage();
  assert.equal(current.ready, true);
  assert.equal(current.tokens, 50);
});
