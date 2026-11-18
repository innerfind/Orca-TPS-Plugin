import { readTargetSession, discoverUsageUnits } from './data.mjs';
import { readActiveConversation } from './active-conversation.mjs';
import { createTpsController } from './controller.mjs';
import { createRemoteChannelReader } from './remote-channel.mjs';
import { createUsageIndex } from './usage-summary.mjs';

// Backfill runs quickly while files are pending; once every unit is current, refresh slowly.
const BACKFILL_DELAY_MS = 15_000, IDLE_DELAY_MS = 60_000, FIRST_DELAY_MS = 3_000;

let controller, remote, usage, timer, handler, running = false;

export default async function activate(orca) {
  await deactivate();
  running = true;
  const remoteReader = remote = createRemoteChannelReader(orca);
  controller = createTpsController(orca, {
    readActive: () => readActiveConversation({ includeRemote: true }),
    readSession: (target, options) => target.executionHostId
      ? remoteReader.read(target, options)
      : readTargetSession(target, options),
    onTargetChange: remoteReader.setTarget
  });
  await controller.start({ background: true });
  usage = createUsageIndex({ storage: orca.storage, discover: discoverUsageUnits, log: message => orca.log(message) });
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
  let pending = 0;
  try {
    ({ pending } = await usage.refresh());
  } catch (error) {
    orca.log(`统计刷新失败：${error?.message ?? 'unknown'}`);
  }
  if (running) schedule(orca, pending > 0 ? BACKFILL_DELAY_MS : IDLE_DELAY_MS);
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
  const remoteReader = remote;
  remote = undefined;
  await remoteReader?.dispose();
}
