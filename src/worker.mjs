import { createLiveSessionReader, discoverUsageUnits } from './data.mjs';
import { readActiveConversation } from './active-conversation.mjs';
import { createTpsController } from './controller.mjs';
import { createRemoteChannelReader, createRemoteUsageReader } from './remote-channel.mjs';
import { createChannelCache } from './channel-cache.mjs';
import { createUsageIndex } from './usage-summary.mjs';

// Backfill runs quickly while files are pending; once every unit is current, refresh slowly.
const BACKFILL_DELAY_MS = 15_000, IDLE_DELAY_MS = 60_000, FIRST_DELAY_MS = 3_000;

let controller, remote, local, cache, usage, remoteUsage, usageAbort, timer, handler, running = false;

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
  usage = createUsageIndex({
    storage: orca.storage,
    async discover(cutoffMs) {
      const [localUnits, remoteUnits] = await Promise.all([discoverUsageUnits(cutoffMs), history.discover(cutoffMs)]);
      return { ...remoteUnits, descriptors: [...localUnits, ...remoteUnits.descriptors] };
    },
    log: message => orca.log(message)
  });
  void usage.ready();
  handler = orca.panels.handle('tps.summary', async () => {
    await usage.ready();
    return usage.summary();
  });
  schedule(orca, FIRST_DELAY_MS);
}

function schedule(orca, delay) {
  clearTimeout(timer);
  timer = setTimeout(() => void tick(orca), delay);
}

async function tick(orca) {
  if (!running) return;
  const index = usage, history = remoteUsage, signal = usageAbort.signal;
  let pending = 0;
  try {
    ({ pending } = await index.refresh({ signal }));
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
  handler?.dispose?.();
  handler = undefined;
  controller?.stop();
  controller = undefined;
  usage = undefined;
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
