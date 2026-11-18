import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLeaderboardServer } from '../server/leaderboard-server.mjs';
import { createLeaderboardService, normalizeServerUrl, periodKeyFor } from '../src/leaderboard.mjs';
import { summarizeLadder } from '../src/usage-summary.mjs';

const ladderHtmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ladder.html');

function createMockOrca({ capabilities = ['storage:own', 'workspace:read', 'secrets:own', 'settings:own'] } = {}) {
  const storageMap = new Map();
  const secretsMap = new Map();
  const settingsMap = new Map();
  const logs = [];
  return {
    storageMap,
    secretsMap,
    settingsMap,
    logs,
    grantedCapabilities: capabilities,
    log(msg) { logs.push(msg); },
    storage: {
      async keys() { return [...storageMap.keys()]; },
      async get(key) { return storageMap.has(key) ? structuredClone(storageMap.get(key)) : null; },
      async set(key, value) { storageMap.set(key, structuredClone(value)); },
      async delete(key) { storageMap.delete(key); }
    },
    secrets: {
      async get(key) { return secretsMap.get(key) ?? null; },
      async set(key, value) { secretsMap.set(key, String(value)); },
      async delete(key) { secretsMap.delete(key); }
    },
    settings: {
      async get(key) { return key ? settingsMap.get(key) : Object.fromEntries(settingsMap); },
      async set(key, value) { settingsMap.set(key, structuredClone(value)); }
    }
  };
}

async function startTestServer(t, options = {}) {
  const srv = createLeaderboardServer({ dbPath: ':memory:', ...options });
  await new Promise(resolve => srv.server.listen(0, '127.0.0.1', resolve));
  const addr = srv.server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(() => srv.close());
  return { ...srv, baseUrl };
}

test('normalizeServerUrl accepts http/https only and strips trailing slash', () => {
  assert.equal(normalizeServerUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(normalizeServerUrl('https://tps.example.com/api/'), 'https://tps.example.com/api');
  assert.equal(normalizeServerUrl('file:///etc/passwd'), null);
  assert.equal(normalizeServerUrl('javascript:alert(1)'), null);
  assert.equal(normalizeServerUrl('https://user:pass@example.com'), null);
});

test('end-to-end ladder: anon join, sanitized sync, Top 100 + self outside/inside Top 100 across day/month/year', async t => {
  const fixedNow = new Date(2026, 10, 18, 14, 0, 0).getTime();
  const { baseUrl, seedDemo } = await startTestServer(t, { now: () => fixedNow });
  seedDemo({ nowMs: fixedNow });

  const orca = createMockOrca();
  const uploadedPayloads = [];
  const spyFetch = async (url, init) => {
    if (String(url).endsWith('/v1/usage/sync') && init?.body) {
      uploadedPayloads.push(JSON.parse(init.body));
    }
    return fetch(url, init);
  };

  let units = new Map([
    ['unit-local-secret-path', {
      days: {
        '2026-11-18': { claude: { 'claude-opus-5-5': [5, 100, 50, 200, 0] } },
        '2026-11-02': { codex: { 'gpt-6': [3, 500, 100, 0, 0] } },
        '2026-03-10': { pi: { m: [2, 300, 100, 0, 0] } }
      }
    }]
  ]);

  const client = createLeaderboardService(orca, {
    getSnapshot: localScopeId => summarizeLadder(units.entries(), fixedNow, {
      localScopeId,
      coveredRemoteScopes: new Set()
    }),
    fetchImpl: spyFetch,
    now: () => fixedNow,
    readDisplayHint: async () => 'TestPlayer'
  });

  await client.saveConfig({ serverUrl: baseUrl });
  const joined = await client.authAnon({ displayName: 'Alice' });
  assert.equal(joined.auth.authenticated, true);
  assert.ok(joined.auth.claimCode?.startsWith('ORCA-'));
  assert.ok(orca.secretsMap.has('leaderboard:token:v1'), 'Bearer token must live in secrets, never storage');
  assert.ok(!JSON.stringify([...orca.storageMap.values()]).includes(orca.secretsMap.get('leaderboard:token:v1')));

  // Verify privacy: uploaded payload only contains sourceScope, day, realTokens, netTokens, requests.
  assert.equal(uploadedPayloads.length, 1);
  for (const entry of uploadedPayloads[0].entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['day', 'netTokens', 'realTokens', 'requests', 'sourceScope']);
  }
  assert.ok(!JSON.stringify(uploadedPayloads).includes('unit-local-secret-path'));

  // Ranked outside Top 100 initially (day tokens = 350 vs 115 seeded players).
  const dayOut = await client.refreshBoard({ period: 'day', metric: 'real', syncFirst: true });
  assert.equal(uploadedPayloads.length, 1, 'unchanged days are not re-uploaded');
  assert.equal(dayOut.board.top100.length, 100);
  assert.equal(dayOut.board.totalParticipants, 116);
  assert.equal(dayOut.board.me.rank, 116);
  assert.equal(dayOut.board.me.inTop100, false);
  assert.ok(dayOut.board.me.gapToTop100 > 0);
  assert.equal(dayOut.board.me.realTokens, 350);

  // Boost Alice's usage into Top 100 across day, month, and year.
  units.set('unit-big', {
    days: {
      '2026-11-18': { claude: { 'claude-opus-5-5': [500, 100_000_000, 50_000_000, 4_000_000_000, 0] } }
    }
  });
  const dayIn = await client.refreshBoard({ period: 'day', metric: 'real', syncFirst: true });
  assert.equal(uploadedPayloads.length, 2, 'only changed day triggers upload');
  assert.equal(dayIn.board.me.rank, 1);
  assert.equal(dayIn.board.me.inTop100, true);
  assert.equal(dayIn.board.top100[0].isSelf, true);
  assert.equal(dayIn.board.top100[0].displayName, 'Alice');

  const monthRes = await client.refreshBoard({ period: 'month', metric: 'real', syncFirst: false });
  assert.equal(monthRes.board.key, '2026-11');
  assert.equal(monthRes.board.me.realTokens, 4_150_000_950);

  const yearRes = await client.refreshBoard({ period: 'year', metric: 'net', syncFirst: false });
  assert.equal(yearRes.board.key, '2026');
  assert.equal(yearRes.board.me.netTokens, 150_001_150);

  // Toggle anonymous mode: other viewers see masked name, self still sees rank.
  await client.updateProfile({ anonymousMode: true });
  const anonView = await fetch(`${baseUrl}/v1/leaderboard?period=day&key=2026-11-18`).then(r => r.json());
  assert.ok(anonView.top100[0].displayName.startsWith('匿名选手 #'));
  assert.equal(anonView.top100[0].isSelf, false);
});

test('two desktops claiming the same account deduplicate shared remote SSH host and combine local scopes', async t => {
  const fixedNow = new Date(2026, 10, 18, 14, 0, 0).getTime();
  const { baseUrl } = await startTestServer(t, { now: () => fixedNow });
  const sharedRemote = 'remote:abcdef0123456789abcdef01:';

  const makeClient = (localTokens) => {
    const orca = createMockOrca();
    const units = new Map([
      ['local-u1', { days: { '2026-11-18': { codex: { m: [1, localTokens, 0, 0, 0] } } } }],
      [`${sharedRemote}rem-u1`, { days: { '2026-11-18': { claude: { m: [2, 500, 500, 0, 0] } } } }]
    ]);
    return createLeaderboardService(orca, {
      getSnapshot: localScopeId => summarizeLadder(units.entries(), fixedNow, {
        localScopeId,
        coveredRemoteScopes: new Set([sharedRemote])
      }),
      now: () => fixedNow
    });
  };

  const pcA = makeClient(200);
  await pcA.saveConfig({ serverUrl: baseUrl });
  const stateA = await pcA.authAnon({ displayName: 'DualMachine' });

  const pcB = makeClient(300);
  await pcB.saveConfig({ serverUrl: baseUrl });
  await pcB.authClaim({ claimCode: stateA.auth.claimCode });

  const board = await pcB.refreshBoard({ period: 'day', syncFirst: true });
  // localA (200) + localB (300) + sharedRemote (1000, counted ONCE) = 1500.
  assert.equal(board.board.me.realTokens, 1500);
  assert.equal(board.board.me.requests, 4);
});

test('GitHub OAuth Device Flow completes authorization and offline fallback uses cached board', async t => {
  const fixedNow = new Date(2026, 10, 18, 14, 0, 0).getTime();
  let pollHits = 0;
  const mockGithubFetch = async (url) => {
    if (String(url).includes('/login/device/code')) {
      return new Response(JSON.stringify({
        device_code: 'dev-code-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5
      }), { status: 200 });
    }
    if (String(url).includes('/login/oauth/access_token')) {
      pollHits += 1;
      if (pollHits === 1) return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 200 });
      return new Response(JSON.stringify({ access_token: 'gho_secret_token' }), { status: 200 });
    }
    if (String(url).includes('api.github.com/user')) {
      return new Response(JSON.stringify({
        id: 4242,
        login: 'octocat',
        name: 'The Octocat',
        avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4'
      }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const srv = await startTestServer(t, {
    githubClientId: 'test-client-id',
    githubFetch: mockGithubFetch,
    now: () => fixedNow
  });

  const orca = createMockOrca();
  const client = createLeaderboardService(orca, {
    getSnapshot: localScopeId => summarizeLadder(new Map([
      ['u1', { days: { '2026-11-18': { claude: { m: [1, 100, 100, 0, 0] } } } }]
    ]).entries(), fixedNow, { localScopeId }),
    now: () => fixedNow
  });
  await client.saveConfig({ serverUrl: srv.baseUrl });

  const started = await client.authGithubStart();
  assert.equal(started.userCode, 'ABCD-1234');
  const firstPoll = await client.authGithubPoll({ deviceCode: started.deviceCode });
  assert.equal(firstPoll.status, 'pending');
  const secondPoll = await client.authGithubPoll({ deviceCode: started.deviceCode });
  assert.equal(secondPoll.status, 'authorized');
  assert.equal(secondPoll.state.auth.user.displayName, 'The Octocat');
  assert.equal(secondPoll.state.auth.user.authKind, 'github');

  const online = await client.refreshBoard({ period: 'day', syncFirst: true });
  assert.equal(online.board.top100[0].avatarUrl, 'https://avatars.githubusercontent.com/u/583231?v=4');

  // Stop server -> cached board must still be returned alongside problem message.
  await srv.close();
  const offline = await client.refreshBoard({ period: 'day', syncFirst: false });
  assert.ok(offline.problem, 'offline state surfaces connection warning');
  assert.equal(offline.board?.top100?.[0]?.displayName, 'The Octocat');
});

test('server rejects tampered or invalid sync entries', async t => {
  const fixedNow = new Date(2026, 10, 18, 14, 0, 0).getTime();
  const { baseUrl } = await startTestServer(t, { now: () => fixedNow });
  const reg = await fetch(`${baseUrl}/v1/auth/anon`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Cheater' })
  }).then(r => r.json());

  for (const bad of [
    [{ sourceScope: 'bad', day: '2026-11-18', realTokens: 10, netTokens: 10, requests: 1 }],
    [{ sourceScope: 'local:abcdef0123456789', day: '2026-11-18', realTokens: 10, netTokens: 20, requests: 1 }],
    [{ sourceScope: 'local:abcdef0123456789', day: '2026-11-18', realTokens: -1, netTokens: 0, requests: 1 }],
    [{ sourceScope: 'local:abcdef0123456789', day: '2020-01-01', realTokens: 10, netTokens: 10, requests: 1 }]
  ]) {
    const res = await fetch(`${baseUrl}/v1/usage/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reg.token}` },
      body: JSON.stringify({ entries: bad })
    });
    assert.equal(res.status, 400);
  }
});

test('ladder.html renders safely without innerHTML and includes day/month/year tabs', async () => {
  const html = await readFile(ladderHtmlPath, 'utf8');
  assert.ok(!html.includes('innerHTML'), 'ladder.html must never use innerHTML');
  assert.match(html, /data-period="day"/);
  assert.match(html, /data-period="month"/);
  assert.match(html, /data-period="year"/);
  assert.match(html, /safeHttpsUrl/);
  assert.equal(periodKeyFor('day', new Date(2026, 10, 18).getTime()), '2026-11-18');
  assert.equal(periodKeyFor('month', new Date(2026, 10, 18).getTime()), '2026-11');
  assert.equal(periodKeyFor('year', new Date(2026, 10, 18).getTime()), '2026');
});
