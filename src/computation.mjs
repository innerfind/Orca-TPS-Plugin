import { Worker } from 'node:worker_threads';

// The Orca worker owns IPC, credentials and scheduling. Disk readers and synchronous
// parsers live on a separate thread so neither a large scan nor a busy DB holds up IPC.
export function createComputation() {
  let thread, nextId = 0, stopped = false;
  const pending = new Map();

  function start() {
    const worker = new Worker(new URL('./computation-worker.mjs', import.meta.url));
    const fail = error => {
      if (thread !== worker) return;
      thread = undefined;
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`TPS computation worker stopped (${code})`)));
    worker.on('message', ({ id, result, error }) => {
      const request = pending.get(id);
      if (!request || thread !== worker) return;
      pending.delete(id);
      if (error) request.reject(Object.assign(new Error(error.message), { code: error.code }));
      else request.resolve(result);
    });
    return worker;
  }

  async function call(operation, ...args) {
    if (stopped) throw new Error('TPS computation worker is closed');
    const worker = thread ??= start();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, operation, args }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }

  async function close() {
    stopped = true;
    await thread?.terminate();
  }

  return { call, close };
}
