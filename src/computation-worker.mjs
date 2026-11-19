import { parentPort } from 'node:worker_threads';
import { readActiveConversation } from './active-conversation.mjs';
import { createLiveSessionReader, discoverUsageUnits } from './data.mjs';
import { decodeCollectorReply, readSshTargets } from './remote-channel.mjs';

const live = createLiveSessionReader();
let usageUnits = new Map();

const operations = {
  active: readActiveConversation,
  live: live.read,
  sshTargets: readSshTargets,
  remoteReply: decodeCollectorReply,
  async discover(cutoff, options) {
    let complete = true;
    const units = await discoverUsageUnits(cutoff, { ...options, onUnavailable: () => { complete = false; } });
    usageUnits = new Map(units.map(unit => [unit.key, unit]));
    const descriptors = units.map(({ key, stamp, bytes, mtimeMs }) => ({ key, stamp, bytes, mtimeMs }));
    return { descriptors, complete };
  },
  async usage(key, stamp) {
    const unit = usageUnits.get(key);
    if (unit?.stamp !== stamp) throw new Error('TPS usage source changed');
    return unit.read();
  }
};

parentPort.on('message', async ({ id, operation, args }) => {
  try {
    const result = await operations[operation](...args);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error?.message ?? String(error), code: error?.code } });
  }
});
