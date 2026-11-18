import { createLiveSessionReader, discoverUsageUnits } from './data.mjs';
import { readActiveConversation } from './active-conversation.mjs';
import { createTpsController } from './controller.mjs';
import { createRemoteChannelReader, createRemoteUsageReader } from './remote-channel.mjs';
import { createChannelCache } from './channel-cache.mjs';
import { createUsageIndex } from './usage-summary.mjs';
import { createLeaderboardService } from './leaderboard.mjs';

// Backfill runs quickly while files are pending; once every unit is current, refresh slowly.
const BACKFILL_DELAY_MS = 15_000, IDLE_DELAY_MS = 60_000, FIRST_DELAY_MS = 3_000;

let controller, remote, local, cache, usage, remoteUsage, leaderboard, usageAbort, timer, running = false;
const handlers = [];

export default async function activate(orca) {
  await deactivate();
  running = true;
  const remoteReader = remote = createRemoteChannelReader(orca);
  const localReader = local = createLiveSessionReader();
  const channelCache = cache = createChannelCache(orca.storage);
  controller = createTpsController(orca, {
    cache: channelCache,
    pollMs: 250,
    readActive: () => readActiveConversation({ includeRemote: true, includeOpen: true }),
    readSession: (target, options) => target.executionHostId
      ? remoteReader.read(target, options)
      : localReader.read(target, options),
    onOpenTargets: remoteReader.setTargets
  });
  await controller.start({ background: true });
  const history = remoteUsage = createRemoteUsageReader(orca);
  usageAbort = new AbortController();
  const index = usage = createUsageIndex({
    storage: orca.storage,
    async discover(cutoffMs) {
      const [localUnits, remoteUnits] = await Promise.all([discoverUsageUnits(cutoffMs), history.discover(cutoffMs)]);
      return { ...remoteUnits, descriptors: [...localUnits, ...remoteUnits.descriptors] };
    },
    log: message => orca.log(message)
  });
  void index.ready();

  const board = leaderboard = createLeaderboardService(orca, {
    getSnapshot: async localScopeId => {
      await index.ready();
      return index.ladderSnapshot({ localScopeId });
    }
  });
  void board.init();

  handlers.push(
    orca.panels.handle('tps.summary', async () => {
      await index.ready();
      return index.summary();
    }),
    orca.panels.handle('leaderboard.state', () => board.getState()),
    orca.panels.handle('leaderboard.setConfig', input => board.saveConfig(input ?? {})),
    orca.panels.handle('leaderboard.authAnon', input => board.authAnon(input ?? {})),
    orca.panels.handle('leaderboard.authClaim', input => board.authClaim(input ?? {})),
    orca.panels.handle('leaderboard.authGithubStart', () => board.authGithubStart()),
    orca.panels.handle('leaderboard.authGithubPoll', input => board.authGithubPoll(input ?? {})),
    orca.panels.handle('leaderboard.updateProfile', input => board.updateProfile(input ?? {})),
    orca.panels.handle('leaderboard.logout', () => board.logout()),
    orca.panels.handle('leaderboard.refresh', input => board.refreshBoard(input ?? {}))
  );

  if (orca.settings?.onDidChange && (!Array.isArray(orca.grantedCapabilities) || orca.grantedCapabilities.includes('settings:own'))) {
    handlers.push(orca.settings.onDidChange(async change => {
      if (!running || leaderboard !== board) return;
      if (typeof change?.key !== 'string' || !change.key.startsWith('leaderboard.')) return;
      const val = await orca.settings.get(change.key).catch(() => undefined);
      if (change.key === 'leaderboard.serverUrl' && typeof val === 'string') {
        await board.saveConfig({ serverUrl: val }).catch(() => {});
      } else if (change.key === 'leaderboard.enabled' && typeof val === 'boolean') {
        await board.saveConfig({ enabled: val }).catch(() => {});
      } else if (change.key === 'leaderboard.anonymousMode' && typeof val === 'boolean') {
        await board.saveConfig({ anonymousMode: val }).catch(() => {});
      }
    }));
  }

  schedule(orca, FIRST_DELAY_MS);
}

function schedule(orca, delay) {
  clearTimeout(timer);
  timer = setTimeout(() => void tick(orca), delay);
}

async function tick(orca) {
  if (!running) return;
  const index = usage, history = remoteUsage, board = leaderboard, signal = usageAbort.signal;
  let pending = 0;
  try {
    ({ pending } = await index.refresh({ signal }));
    if (running && leaderboard === board && !signal.aborted) {
      await board?.maybeSync();
    }
  } catch (error) {
    if (!signal.aborted) orca.log(`统计刷新失败：${error?.message ?? 'unknown'}`);
  } finally {
    await history.finish();
  }
  if (running && usage === index) schedule(orca, pending > 0 ? BACKFILL_DELAY_MS : IDLE_DELAY_MS);
}

export async function deactivate() {
  running = false;
  clearTimeout(timer);
  timer = undefined;
  while (handlers.length) handlers.pop()?.dispose?.();
  controller?.stop();
  controller = undefined;
  usage = undefined;
  leaderboard?.dispose();
  leaderboard = undefined;
  usageAbort?.abort();
  usageAbort = undefined;
  const history = remoteUsage;
  remoteUsage = undefined;
  const remoteReader = remote;
  remote = undefined;
  local?.close();
  local = undefined;
  const channelCache = cache;
  cache = undefined;
  await Promise.all([remoteReader?.dispose(), history?.dispose(), channelCache?.flush()]);
}
