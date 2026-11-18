import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelCache } from '../src/channel-cache.mjs';

test('one hundred project records persist across restarts with equal timestamps and unchanged reads are not written', async () => {
  const stored = new Map();
  let now = 1000, writes = 0;
  const storage = {
    get: async key => stored.get(key),
    set: async (key, value) => { writes++; stored.set(key, value); }
  };
  const cache = createChannelCache(storage, { now: () => now });
  const request = (id, completedAt) => ({ id, completedAt, provider: 'codex', outputTokens: 250 });
  const history = Array.from({ length: 100 }, (_, i) => request('record-' + i, i));
  cache.set('project', history);
  await cache.flush();
  assert.equal(writes, 1);
  now = 2000;
  const changed = cache.set('project', [...history, request('new', 99)]);
  assert.equal(changed.records.length, 100);
  assert.equal(changed.records.filter(record => record.completedAt === 99).length, 2);
  assert.equal(changed.records.at(-1).completedAt, 1);
  assert.equal(changed.updatedAt, 2000);
  await cache.flush();
  assert.equal(writes, 2);

  const restarted = createChannelCache(storage, { now: () => 3000 });
  assert.deepEqual(await restarted.get('project'), changed);
  assert.deepEqual(restarted.set('project', [...history, request('new', 99)]), changed);
  await restarted.flush();
  assert.equal(writes, 2);
  assert.equal(await restarted.get('different-project'), null);
});
