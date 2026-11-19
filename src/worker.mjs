import { createLocalePreferences } from './locales.mjs';
import { createLiveSessionReader, discoverUsageUnits } from './data.mjs';
import { readActiveConversation } from './active-conversation.mjs';
import { createTpsController } from './controller.mjs';
import { createRemoteChannelReader, createRemoteUsageReader } from './remote-channel.mjs';
import { createChannelCache } from './channel-cache.mjs';
import { createUsageIndex, MAX_WINDOW_DAYS } from './usage-summary.mjs';
import { startLeaderboard } from './leaderboard.mjs';

// Backfill runs quickly while files are pending; once every unit is current, refresh slowly.
const BACKFILL_DELAY_MS = 15_000, IDLE_DELAY_MS = 60_000, FIRST_DELAY_MS = 3_000;
const PANEL_VIEW_KEY = 'panel-view';
const PANEL_VIEWS = new Set(['current-data', 'usage', 'leaderboard']);

let controller, remote, local, cache, usage, remoteUsage, usageAbort, timer, handler, stopLeaderboard, stopPanelView, running = false;
let locales, localeRegistration;

export default async function activate(orca) {
  await deactivate();
  running = true;
  const language = locales = await createLocalePreferences(orca.storage);
  localeRegistration = orca.panels.handle('tps.locale', payload => payload?.code === undefined
    ? language.response(true)
    : language.select(payload.code, () => { void controller?.refreshLocale(); }));
  stopPanelView = registerPanelView(orca, language.t);
  const remoteReader = remote = createRemoteChannelReader(orca, { t: language.t });
  const localReader = local = createLiveSessionReader();
  const channelCache = cache = createChannelCache(orca.storage);
  controller = createTpsController(orca, {
    cache: channelCache, locales: language,
    pollMs: 250,
    readActive: () => readActiveConversation({ includeRemote: true, includeOpen: true }),
    readSession: (target, options) => target.executionHostId
      ? remoteReader.read(target, options)
      : localReader.read(target, options),
    onOpenTargets: remoteReader.setTargets
  });
  await controller.start({ background: true });
  const history = remoteUsage = createRemoteUsageReader(orca, { t: language.t });
  usageAbort = new AbortController();
  usage = createUsageIndex({
    storage: orca.storage,
    leaderboard: true,
    rankDays: MAX_WINDOW_DAYS,
    async discover(cutoffMs, rankDay, rankFrom) {
      const [localUnits, remoteUnits] = await Promise.all([
        discoverUsageUnits(cutoffMs, { rankDay, rankFrom }), history.discover(cutoffMs, rankDay, rankFrom)
      ]);
      return { ...remoteUnits, descriptors: [...localUnits, ...remoteUnits.descriptors] };
    },
    log: message => orca.log(language.notice(message))
  });
  void usage.ready();
  handler = orca.panels.handle('tps.summary', async () => {
    await usage.ready();
    return usage.summary();
  });
  const index = usage;
  try {
    stopLeaderboard = startLeaderboard(orca, {
      async readUsage() {
        await index.ready();
        return index.leaderboardUsage();
      },
      async readHistory() {
        await index.ready();
        return index.leaderboardHistory();
      }
    });
  } catch { orca.log(language.t('notice.leaderboard-url-invalid')); }
  schedule(orca, FIRST_DELAY_MS);
}

function registerPanelView(orca, t) {
  const saved = orca.storage.get(PANEL_VIEW_KEY).catch(() => undefined);
  let selected, writing = Promise.resolve();
  const registration = orca.panels.handle('tps.panel-view', async payload => {
    const view = payload?.view;
    if (PANEL_VIEWS.has(view) && view !== selected) {
      selected = view;
      writing = writing.then(() => orca.storage.set(PANEL_VIEW_KEY, view)).catch(() => {
        orca.log(t('notice.panel-view-save-failed'));
      });
      await writing;
    }
    if (selected) return { view: selected };
    const restored = await saved;
    return { view: selected ?? (PANEL_VIEWS.has(restored) ? restored : null) };
  });
  return () => {
    registration.dispose();
    return writing;
  };
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
    if (!signal.aborted) orca.log(locales.t('notice.usage-refresh-failed', error?.message ?? 'unknown'));
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
  localeRegistration?.dispose?.();
  localeRegistration = undefined;
  const languageWrite = locales?.flush();
  locales = undefined;
  const panelViewWrite = stopPanelView?.();
  stopPanelView = undefined;
  stopLeaderboard?.();
  stopLeaderboard = undefined;
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
  await Promise.all([remoteReader?.dispose(), history?.dispose(), channelCache?.flush(), panelViewWrite, languageWrite]);
}
