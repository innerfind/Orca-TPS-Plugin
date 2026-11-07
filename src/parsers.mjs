const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const name = value => typeof value === 'string' && value.trim() && value.length <= 256 ? value.trim() : null;
const time = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const json = value => { try { return record(JSON.parse(value)); } catch { return null; } };

export const SPEED_MIN_OUTPUT_TOKENS = 100;
export const SPEED_MIN_GENERATION_MS = 100;
export const SPEED_ESTIMATE_MIN_OUTPUT_TOKENS = 200;
export const SPEED_ESTIMATE_MIN_DURATION_MS = 1000;
export const MIN_PLAUSIBLE_LATENCY_MS = 100;
export const MAX_PLAUSIBLE_LATENCY_MS = 60 * 60 * 1000;
export const SESSION_PROXY_DEDUP_WINDOW_SECONDS = 600;

const MAX_CHAIN_HOPS = 32;
const SAME_FLUSH_SLACK_MS = 100;
const CODEX_USAGE_KEYS = [
  'input_tokens', 'cached_input_tokens', 'cache_read_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'
];

export function estimatedLatencyMs(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const latency = Math.round(endMs - startMs);
  return latency >= MIN_PLAUSIBLE_LATENCY_MS && latency <= MAX_PLAUSIBLE_LATENCY_MS ? latency : null;
}

export function estimatedFirstTokenMs(startMs, firstOutputMs, latencyMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(firstOutputMs) || !Number.isFinite(latencyMs) || latencyMs <= 0) return null;
  const firstToken = Math.round(firstOutputMs - startMs);
  return firstToken > 0 && firstToken <= latencyMs ? firstToken : null;
}

export function isSessionLogSource(dataSource) {
  return typeof dataSource === 'string' && dataSource.length > 0 && dataSource !== 'proxy';
}

export function computeSpeedMetrics({ outputTokens, durationMs, firstTokenMs = null, dataSource = 'session_log' }) {
  const output = count(outputTokens);
  const latency = count(durationMs);
  const firstToken = count(firstTokenMs);
  if (!isSessionLogSource(dataSource)) {
    const generationMs = latency !== null && firstToken !== null && latency > firstToken ? latency - firstToken : null;
    if (output !== null && output >= SPEED_MIN_OUTPUT_TOKENS && generationMs !== null && generationMs >= SPEED_MIN_GENERATION_MS) {
      const tps = output / (generationMs / 1000);
      if (Number.isFinite(tps) && tps > 0) {
        return { tokensPerSecond: tps, isEstimatedSpeed: false, generationMs };
      }
    }
    return { tokensPerSecond: null, isEstimatedSpeed: false, generationMs };
  }
  if (output !== null && output >= SPEED_ESTIMATE_MIN_OUTPUT_TOKENS && latency !== null && latency >= SPEED_ESTIMATE_MIN_DURATION_MS) {
    const tps = output / (latency / 1000);
    if (Number.isFinite(tps) && tps > 0) {
      return { tokensPerSecond: tps, isEstimatedSpeed: true, generationMs: null };
    }
  }
  return { tokensPerSecond: null, isEstimatedSpeed: false, generationMs: null };
}

export function formatTokensPerSecond(tps) {
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return null;
  return tps >= 1 ? String(Math.round(tps)) : tps.toFixed(1);
}

export function formatSpeedDisplay(entry) {
  const formatted = formatTokensPerSecond(entry?.tokensPerSecond);
  if (!formatted) return '—';
  return entry?.isEstimatedSpeed ? `≈${formatted}` : formatted;
}

export function formatHitRatePercent(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) return '—';
  const percent = Math.max(0, Math.min(100, rate * 100));
  return `${percent.toFixed(percent >= 99.95 ? 0 : 1)}%`;
}

export function normalizeCodexModel(value) {
  const raw = name(value);
  if (!raw) return null;
  const afterSlash = raw.slice(raw.lastIndexOf('/') + 1).trim().toLowerCase();
  if (!afterSlash) return null;
  return afterSlash.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '') || null;
}

function computeCacheHitRate(inputTokens, cacheReadTokens, cacheCreationTokens, cacheInclusive = false) {
  const input = count(inputTokens), read = count(cacheReadTokens), write = count(cacheCreationTokens);
  if (input === null || read === null || write === null) return null;
  const fresh = cacheInclusive ? Math.max(0, input - read - write) : input;
  const cacheable = fresh + write + read;
  return cacheable > 0 && read <= cacheable ? read / cacheable : null;
}

function buildRecord({
  id, rawId = null, completedAt, createdAtSec = null, dataSource,
  inputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0, cacheInclusive = false,
  outputTokens, durationMs, firstTokenMs = null, model = null, isSubagent = false
}) {
  if (!Number.isFinite(completedAt)) return null;
  const inTok = count(inputTokens) ?? 0;
  const readTok = count(cacheReadTokens) ?? 0;
  const writeTok = count(cacheCreationTokens) ?? 0;
  const freshInputTokens = cacheInclusive ? Math.max(0, inTok - readTok - writeTok) : inTok;
  const outTok = count(outputTokens);
  const latency = count(durationMs);
  const validDuration = latency !== null && latency > 0 ? latency : null;
  const validFirstToken = validDuration !== null && count(firstTokenMs) !== null && firstTokenMs > 0 && firstTokenMs <= validDuration
    ? count(firstTokenMs) : null;
  const speed = computeSpeedMetrics({ outputTokens: outTok, durationMs: validDuration, firstTokenMs: validFirstToken, dataSource });
  const cacheHitRate = computeCacheHitRate(inTok, readTok, writeTok, cacheInclusive);
  const sec = Number.isFinite(createdAtSec) ? Math.floor(createdAtSec) : Math.floor(completedAt / 1000);
  const cleanModel = name(model);
  return {
    id,
    ...(rawId ? { rawId } : {}),
    completedAt,
    createdAtSec: sec,
    dataSource,
    freshInputTokens,
    outputTokens: outTok,
    cacheReadTokens: readTok,
    cacheCreationTokens: writeTok,
    durationMs: validDuration,
    firstTokenMs: validFirstToken,
    generationMs: speed.generationMs,
    tokensPerSecond: speed.tokensPerSecond,
    isEstimatedSpeed: speed.isEstimatedSpeed,
    ...(cacheHitRate !== null ? { cacheHitRate } : {}),
    ...(cleanModel && cleanModel !== 'unknown' ? { model: cleanModel } : {}),
    ...(isSubagent ? { isSubagent: true } : {})
  };
}

export function recentRecords(records) {
  return [...new Map(records.filter(Boolean).map(value => [value.id, value])).values()]
    .sort((a, b) => b.completedAt - a.completedAt).slice(0, 100);
}

const maxOpt = (a, b) => a === null ? b : b === null ? a : Math.max(a, b);

function parseCodexTokens(value) {
  const obj = record(value);
  if (!obj || !CODEX_USAGE_KEYS.some(key => count(obj[key]) !== null)) return null;
  return {
    input: count(obj.input_tokens) ?? 0,
    cachedInput: count(obj.cached_input_tokens) ?? count(obj.cache_read_input_tokens) ?? 0,
    cacheWriteInput: count(obj.cache_write_input_tokens) ?? 0,
    output: count(obj.output_tokens) ?? 0,
    reasoningOutput: count(obj.reasoning_output_tokens),
    total: count(obj.total_tokens)
  };
}

function codexTokenSignature(info) {
  const total = record(info?.total_token_usage), last = record(info?.last_token_usage);
  if (!parseCodexTokens(total) && !parseCodexTokens(last)) return null;
  const pick = src => src ? [
    count(src.input_tokens),
    count(src.cached_input_tokens) ?? count(src.cache_read_input_tokens),
    count(src.output_tokens),
    count(src.reasoning_output_tokens),
    count(src.total_tokens)
  ] : null;
  return JSON.stringify([pick(total), pick(last)]);
}

function parseCodex(rows, sessionId, { truncated = false } = {}) {
  const results = [];
  const lastSignatureBySource = new Map();
  let previousTokenSignature = null;
  let totalHighWater = null;
  let currentModel = null;
  let eventIndex = 0;

  let lastBoundaryMs = null;
  let requestStartMs = null;
  let lastModelOutputMs = null;
  let toolOutputAfterModelOutputMs = null;
  let firstOutputMs = null;
  let usageRecord = null;
  let pendingUsageRecord = null;
  let lastTokenCountMs = null;

  const resetInFlight = boundaryMs => {
    requestStartMs = null;
    lastModelOutputMs = null;
    toolOutputAfterModelOutputMs = null;
    firstOutputMs = null;
    usageRecord = null;
    if (boundaryMs !== null) lastBoundaryMs = maxOpt(lastBoundaryMs, boundaryMs);
  };

  const finishRequest = (tokenCountMs, last) => {
    const startMs = requestStartMs ?? lastBoundaryMs;
    const saved = usageRecord;
    const recordEndMs = saved && (last === null || (
      saved.usage.input === last.input &&
      saved.usage.cachedInput === last.cachedInput &&
      saved.usage.output === last.output
    )) ? saved.timestampMs : null;
    const waitedForTools = toolOutputAfterModelOutputMs !== null &&
      (tokenCountMs === null || (tokenCountMs - toolOutputAfterModelOutputMs) <= SAME_FLUSH_SLACK_MS);
    const endMs = recordEndMs ?? (waitedForTools ? lastModelOutputMs : tokenCountMs);
    const latencyMs = startMs !== null && endMs !== null ? estimatedLatencyMs(startMs, endMs) : null;
    const ttftMs = startMs !== null && firstOutputMs !== null && latencyMs !== null
      ? estimatedFirstTokenMs(startMs, firstOutputMs, latencyMs) : null;
    resetInFlight(tokenCountMs);
    if (tokenCountMs !== null) lastTokenCountMs = tokenCountMs;
    return { latencyMs, firstTokenMs: ttftMs, endMs: endMs ?? tokenCountMs };
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const atRaw = time(row.timestamp), at = Number.isFinite(atRaw) ? atRaw : null;
    const payload = record(row.payload);

    if (row.type === 'turn_context') {
      const m = normalizeCodexModel(payload?.model ?? record(payload?.info)?.model);
      if (m) currentModel = m;
      if (at !== null) lastBoundaryMs = maxOpt(lastBoundaryMs, at);
      continue;
    }

    if (row.type === 'response_item' && payload) {
      const pType = typeof payload.type === 'string' ? payload.type : '';
      if (pType === 'message' && payload.role !== 'assistant') {
        if (at !== null) lastBoundaryMs = maxOpt(lastBoundaryMs, at);
      } else if (pType.endsWith('_output')) {
        if (at !== null) {
          lastBoundaryMs = maxOpt(lastBoundaryMs, at);
          if (lastModelOutputMs !== null) toolOutputAfterModelOutputMs = at;
        }
      } else if ((pType === 'message' && payload.role === 'assistant') || pType === 'reasoning' || pType.endsWith('_call')) {
        if (at !== null) {
          const trailingFlush = requestStartMs === null && lastTokenCountMs !== null && (at - lastTokenCountMs) <= SAME_FLUSH_SLACK_MS;
          if (!trailingFlush) {
            if (requestStartMs === null) requestStartMs = lastBoundaryMs;
            lastModelOutputMs = at;
            toolOutputAfterModelOutputMs = null;
          }
        }
      }
      continue;
    }

    if (row.type === 'token_usage_record' && payload) {
      const parsedUsage = parseCodexTokens(payload.usage);
      if (parsedUsage) {
        usageRecord = { timestampMs: at, usage: parsedUsage };
        pendingUsageRecord = {
          timestampMs: at,
          usage: parsedUsage,
          key: name(payload.response_id) ?? `line-${i}`,
          model: currentModel
        };
      }
      continue;
    }

    if (row.type !== 'event_msg' || !payload) continue;

    if (payload.type === 'thread_settings_applied') {
      const m = normalizeCodexModel(record(payload.thread_settings)?.model);
      if (m) currentModel = m;
      continue;
    }

    if (payload.type === 'item_completed') {
      const itemType = record(payload.item)?.type;
      if (itemType === 'Reasoning' || itemType === 'AgentMessage') {
        const startedAt = count(payload.started_at_ms);
        if (startedAt !== null && startedAt > 0) {
          firstOutputMs = firstOutputMs === null ? startedAt : Math.min(firstOutputMs, startedAt);
        }
      }
      continue;
    }

    if (payload.type === 'task_started' || payload.type === 'turn_started' || payload.type === 'turn_aborted') {
      resetInFlight(at);
      continue;
    }

    if (payload.type !== 'token_count') continue;
    const info = record(payload.info);
    if (!info) continue;
    const explicitModel = normalizeCodexModel(info.model ?? info.model_name ?? payload.model);
    if (explicitModel) currentModel = explicitModel;

    const signature = codexTokenSignature(info);
    if (!signature) continue;
    const total = parseCodexTokens(info.total_token_usage);
    const last = parseCodexTokens(info.last_token_usage);
    const limitId = name(record(payload.rate_limits)?.limit_id) ?? '';
    const isDuplicate = total !== null && (
      lastSignatureBySource.get(limitId) === signature || previousTokenSignature === signature
    );
    if (total !== null) lastSignatureBySource.set(limitId, signature);
    previousTokenSignature = signature;

    if (pendingUsageRecord) {
      const pending = pendingUsageRecord;
      pendingUsageRecord = null;
      const lastIsZero = last !== null && last.input === 0 && last.cachedInput === 0 && last.cacheWriteInput === 0 && last.output === 0;
      const matchesPending = last !== null &&
        last.input === pending.usage.input &&
        last.cachedInput === pending.usage.cachedInput &&
        last.cacheWriteInput === pending.usage.cacheWriteInput &&
        last.output === pending.usage.output;
      if (lastIsZero && !matchesPending && (pending.usage.input > 0 || pending.usage.cachedInput > 0 || pending.usage.output > 0)) {
        const u = pending.usage;
        const clampedRead = Math.min(u.cachedInput, u.input);
        const clampedWrite = Math.min(u.cacheWriteInput, u.input - clampedRead);
        if (pending.timestampMs !== null) {
          results.push(buildRecord({
            id: `codex_session:${sessionId || 'session'}:usage:${pending.key}`,
            completedAt: pending.timestampMs,
            dataSource: 'codex_session',
            inputTokens: u.input,
            cacheReadTokens: clampedRead,
            cacheCreationTokens: clampedWrite,
            cacheInclusive: true,
            outputTokens: u.output,
            durationMs: null,
            model: pending.model
          }));
        }
      }
    }

    if (isDuplicate) continue;

    let delta = null;
    if (last !== null) {
      delta = { ...last };
      if (total !== null) {
        if (!totalHighWater || (total.output < totalHighWater.output && total.output === last.output && total.input === last.input)) {
          totalHighWater = { ...total };
        } else {
          totalHighWater = {
            input: Math.max(totalHighWater.input, total.input),
            cachedInput: Math.max(totalHighWater.cachedInput, total.cachedInput),
            cacheWriteInput: Math.max(totalHighWater.cacheWriteInput, total.cacheWriteInput),
            output: Math.max(totalHighWater.output, total.output)
          };
        }
      }
    } else if (total !== null) {
      if (truncated && !totalHighWater) {
        totalHighWater = { ...total };
        resetInFlight(at);
        if (at !== null) lastTokenCountMs = at;
        continue;
      }
      const base = totalHighWater ?? { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 };
      delta = {
        input: Math.max(0, total.input - base.input),
        cachedInput: Math.max(0, total.cachedInput - base.cachedInput),
        cacheWriteInput: Math.max(0, total.cacheWriteInput - base.cacheWriteInput),
        output: Math.max(0, total.output - base.output)
      };
      totalHighWater = {
        input: Math.max(base.input, total.input),
        cachedInput: Math.max(base.cachedInput, total.cachedInput),
        cacheWriteInput: Math.max(base.cacheWriteInput, total.cacheWriteInput),
        output: Math.max(base.output, total.output)
      };
    }
    if (!delta) continue;

    const cachedInput = Math.min(delta.cachedInput, delta.input);
    const cacheWriteInput = Math.min(delta.cacheWriteInput, delta.input - cachedInput);
    if (delta.input === 0 && cachedInput === 0 && delta.output === 0) continue;

    const timing = finishRequest(at, last);
    const completedAt = timing.endMs ?? at;
    if (completedAt === null) continue;
    eventIndex += 1;
    results.push(buildRecord({
      id: `codex_session:${sessionId || 'session'}:${eventIndex}`,
      completedAt,
      dataSource: 'codex_session',
      inputTokens: delta.input,
      cacheReadTokens: cachedInput,
      cacheCreationTokens: cacheWriteInput,
      cacheInclusive: true,
      outputTokens: delta.output,
      durationMs: timing.latencyMs,
      firstTokenMs: timing.firstTokenMs,
      model: currentModel
    }));
  }
  return recentRecords(results);
}

function parseClaude(rows, { isSubagent = false } = {}) {
  const chain = new Map();
  const messages = new Map();
  const timings = new Map();

  for (const row of rows) {
    const uuid = name(row.uuid);
    const atRaw = time(row.timestamp), at = Number.isFinite(atRaw) ? atRaw : null;
    if (uuid) {
      chain.set(uuid, {
        parent: name(row.parentUuid),
        timestampMs: at,
        isAttachment: row.type === 'attachment'
      });
    }
    if (row.type !== 'assistant') continue;
    const message = record(row.message);
    if (!message) continue;
    const msgId = name(message.id) ?? uuid;
    if (!msgId) continue;

    const usage = record(message.usage);
    const inputTokens = count(usage?.input_tokens) ?? 0;
    const outputTokens = count(usage?.output_tokens) ?? 0;
    const cacheReadTokens = count(usage?.cache_read_input_tokens) ?? 0;
    const cacheCreationTokens = count(usage?.cache_creation_input_tokens) ?? 0;
    const stopReason = name(message.stop_reason);
    const model = name(message.model);
    const sidechain = Boolean(isSubagent || row.isSidechain === true);

    let timing = timings.get(msgId);
    if (!timing) {
      const blockIndex = row.apiBlockIndex;
      const startsAtFirstBlock = blockIndex === undefined || blockIndex === null || blockIndex === 0;
      const thinkingDuration = count(row.thinkingDurationMs);
      const firstBlock = Array.isArray(message.content) ? record(message.content[0]) : null;
      const firstOutputMs = startsAtFirstBlock && at !== null && thinkingDuration !== null && thinkingDuration > 0 && firstBlock?.type === 'thinking'
        ? at - thinkingDuration : null;
      timing = {
        firstParent: name(row.parentUuid),
        startsAtFirstBlock,
        endMs: at ?? -Infinity,
        firstOutputMs
      };
      timings.set(msgId, timing);
    } else if (at !== null && at > timing.endMs) {
      timing.endMs = at;
    }

    const existing = messages.get(msgId);
    const hasStop = stopReason !== null, existingHasStop = existing ? existing.stopReason !== null : false;
    const shouldReplace = !existing || (hasStop && !existingHasStop) ||
      (hasStop === existingHasStop && outputTokens > existing.outputTokens);
    if (shouldReplace) {
      messages.set(msgId, {
        msgId,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        stopReason,
        model: model ?? existing?.model ?? null,
        timestampMs: at ?? existing?.timestampMs ?? null,
        isSubagent: sidechain || Boolean(existing?.isSubagent)
      });
    } else if (existing) {
      if (!existing.model && model) existing.model = model;
      if (sidechain) existing.isSubagent = true;
    }
  }

  const resolveRequestStartMs = firstParent => {
    let cursor = firstParent;
    for (let hop = 0; hop < MAX_CHAIN_HOPS && cursor; hop++) {
      const node = chain.get(cursor);
      if (!node) return null;
      if (!node.isAttachment) return node.timestampMs;
      cursor = node.parent;
    }
    return null;
  };

  const results = [];
  for (const [msgId, msg] of messages) {
    if (msg.inputTokens === 0 && msg.outputTokens === 0 && msg.cacheReadTokens === 0 && msg.cacheCreationTokens === 0) continue;
    const timing = timings.get(msgId);
    const endMs = timing && Number.isFinite(timing.endMs) ? timing.endMs : msg.timestampMs;
    if (!Number.isFinite(endMs)) continue;
    let latencyMs = null, firstTokenMs = null;
    if (msg.stopReason !== null && timing?.startsAtFirstBlock && Number.isFinite(timing.endMs)) {
      const startMs = resolveRequestStartMs(timing.firstParent);
      if (startMs !== null) {
        latencyMs = estimatedLatencyMs(startMs, timing.endMs);
        if (latencyMs !== null && timing.firstOutputMs !== null) {
          firstTokenMs = estimatedFirstTokenMs(startMs, timing.firstOutputMs, latencyMs);
        }
      }
    }
    results.push(buildRecord({
      id: `session:${msgId}`,
      rawId: msgId,
      completedAt: endMs,
      createdAtSec: Number.isFinite(msg.timestampMs) ? Math.floor(msg.timestampMs / 1000) : Math.floor(endMs / 1000),
      dataSource: 'session_log',
      inputTokens: msg.inputTokens,
      cacheReadTokens: msg.cacheReadTokens,
      cacheCreationTokens: msg.cacheCreationTokens,
      cacheInclusive: false,
      outputTokens: msg.outputTokens,
      durationMs: latencyMs,
      firstTokenMs,
      model: msg.model,
      isSubagent: msg.isSubagent
    }));
  }
  return recentRecords(results);
}

function piTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) < 100_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) return Math.abs(numeric) < 100_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
    }
    return Date.parse(trimmed);
  }
  return NaN;
}

function extractPiTokens(usageObj) {
  const u = record(usageObj);
  if (!u) return null;
  const input = count(u.input) ?? 0;
  const output = count(u.output) ?? 0;
  const cacheRead = count(u.cacheRead) ?? 0;
  const cacheWrite = count(u.cacheWrite) ?? 0;
  return (input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0)
    ? { input, output, cacheRead, cacheWrite } : null;
}

function parsePi(rows) {
  const results = [];
  let currentModel = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.type === 'model_change') {
      currentModel = name(row.modelId) ?? name(row.model) ?? currentModel;
      continue;
    }
    const entryId = name(row.id) ?? `line-${i}`;
    const entryAt = piTimestampMs(row.timestamp);

    if (row.type === 'compaction' || row.type === 'branch_summary' || row.type === 'model_usage') {
      const tokens = extractPiTokens(row.usage);
      if (!tokens || !Number.isFinite(entryAt)) continue;
      const latencyMs = row.type === 'model_usage' && typeof row.duration === 'number' && Number.isFinite(row.duration) && row.duration > 0
        ? estimatedLatencyMs(0, Math.round(row.duration)) : null;
      results.push(buildRecord({
        id: `pi_session:${entryId}`,
        rawId: entryId,
        completedAt: entryAt,
        dataSource: 'pi_session',
        inputTokens: tokens.input,
        cacheReadTokens: tokens.cacheRead,
        cacheCreationTokens: tokens.cacheWrite,
        cacheInclusive: false,
        outputTokens: tokens.output,
        durationMs: latencyMs,
        model: name(row.model) ?? name(row.modelId) ?? currentModel
      }));
      continue;
    }

    if (row.type !== 'message') continue;
    const message = record(row.message);
    if (!message) continue;

    if (message.role === 'toolResult' && message.toolName === 'subagent' && !record(message.usage)) {
      const details = record(message.details ?? row.details);
      if (details && ['single', 'parallel', 'chain'].includes(details.mode) && !details.sessionFile && Array.isArray(details.results)) {
        details.results.forEach((subResult, subIdx) => {
          const sr = record(subResult);
          if (!sr) return;
          let emittedChild = false;
          if (Array.isArray(sr.messages)) {
            sr.messages.forEach((child, childIdx) => {
              const cm = record(child);
              if (cm?.role !== 'assistant') return;
              const tokens = extractPiTokens(cm.usage);
              if (!tokens) return;
              const childAt = piTimestampMs(cm.timestamp);
              const at = Number.isFinite(childAt) ? childAt : entryAt;
              if (!Number.isFinite(at)) return;
              emittedChild = true;
              results.push(buildRecord({
                id: `pi_session:${entryId}:sub:${subIdx}:${childIdx}`,
                completedAt: at,
                dataSource: 'pi_session',
                inputTokens: tokens.input,
                cacheReadTokens: tokens.cacheRead,
                cacheCreationTokens: tokens.cacheWrite,
                cacheInclusive: false,
                outputTokens: tokens.output,
                durationMs: null,
                model: name(cm.model) ?? currentModel,
                isSubagent: true
              }));
            });
          }
          if (!emittedChild && Number.isFinite(entryAt)) {
            const tokens = extractPiTokens(sr.usage);
            if (tokens) {
              results.push(buildRecord({
                id: `pi_session:${entryId}:sub:${subIdx}`,
                completedAt: entryAt,
                dataSource: 'pi_session',
                inputTokens: tokens.input,
                cacheReadTokens: tokens.cacheRead,
                cacheCreationTokens: tokens.cacheWrite,
                cacheInclusive: false,
                outputTokens: tokens.output,
                durationMs: null,
                model: name(sr.model) ?? currentModel,
                isSubagent: true
              }));
            }
          }
        });
        continue;
      }
    }

    if (message.role !== 'assistant' && message.role !== 'toolResult') continue;
    const tokens = extractPiTokens(message.usage);
    if (!tokens) continue;
    const msgAt = piTimestampMs(message.timestamp);
    const completedAt = Number.isFinite(entryAt) ? entryAt : msgAt;
    if (!Number.isFinite(completedAt)) continue;

    let latencyMs = null;
    if (message.role === 'assistant') {
      if (typeof message.duration === 'number' && Number.isFinite(message.duration) && message.duration > 0) {
        latencyMs = estimatedLatencyMs(0, Math.round(message.duration));
      } else if (Number.isFinite(msgAt) && Number.isFinite(entryAt)) {
        latencyMs = estimatedLatencyMs(msgAt, entryAt);
      }
    }
    results.push(buildRecord({
      id: `pi_session:${entryId}`,
      rawId: entryId,
      completedAt,
      dataSource: 'pi_session',
      inputTokens: tokens.input,
      cacheReadTokens: tokens.cacheRead,
      cacheCreationTokens: tokens.cacheWrite,
      cacheInclusive: false,
      outputTokens: tokens.output,
      durationMs: latencyMs,
      model: name(message.model) ?? currentModel
    }));
  }
  return recentRecords(results);
}

/** Returns metadata and counters only. Chat content never leaves this parser. */
export function parseJsonl(text, provider, headerText = '', options = {}) {
  const parse = value => value.split('\n').map(json).filter(Boolean);
  const rows = parse(text), headers = headerText ? parse(headerText) : rows;
  let sessionId = null, cwd = null;
  for (const row of headers.slice(0, 30)) {
    if (provider === 'codex' && row.type === 'session_meta') {
      sessionId = name(row.payload?.id); cwd = name(row.payload?.cwd);
    } else if (provider === 'pi' && row.type === 'session') {
      sessionId = name(row.id); cwd = name(row.cwd);
    } else if (provider === 'claude') {
      sessionId ??= name(row.sessionId); cwd ??= name(row.cwd);
    }
  }
  const records = provider === 'codex'
    ? parseCodex(rows, sessionId, options)
    : provider === 'claude'
      ? parseClaude(rows, options)
      : provider === 'pi'
        ? parsePi(rows)
        : [];
  return { sessionId, cwd, records };
}

/** Rows are provider message records in storage order, already limited to one session. */
export function parseOpenCodeRows(rows, v2 = false) {
  const byId = new Map();
  for (const row of rows) {
    const data = record(row.data) ?? json(row.data);
    if (!data) continue;
    const rowId = name(String(row.id ?? ''));
    if (!rowId) continue;
    const type = row.type ?? data.role;
    const timeObj = record(data.time);
    const completedMs = time(timeObj?.completed);
    if (v2) {
      if (type === 'assistant') {
        if (!Number.isFinite(completedMs) || completedMs <= 0) continue;
      } else if (type === 'compaction') {
        if (data.status !== 'completed' && data.status !== 'failed') continue;
      } else continue;
    } else {
      if (type !== 'assistant' || !Number.isFinite(completedMs) || completedMs <= 0) continue;
    }

    const tokens = record(data.tokens);
    if (!tokens) continue;
    const input = count(tokens.input) ?? 0;
    const output = count(tokens.output) ?? 0;
    const reasoning = count(tokens.reasoning) ?? 0;
    const cache = record(tokens.cache);
    const cacheRead = count(cache?.read) ?? 0;
    const cacheWrite = count(cache?.write) ?? 0;
    if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheWrite === 0) continue;

    const totalOutput = count(output + reasoning);
    if (totalOutput === null) continue;

    const createdRaw = time(timeObj?.created);
    const createdMs = Number.isFinite(createdRaw) && createdRaw > 0 ? createdRaw : time(row.time_created);
    const streamedMs = time(timeObj?.streamed);
    const endMs = Number.isFinite(streamedMs) && Number.isFinite(createdMs) && streamedMs > createdMs
      ? streamedMs : completedMs;
    const durationMs = Number.isFinite(createdMs) && createdMs > 0 && Number.isFinite(endMs) && endMs > createdMs
      ? Math.round(endMs - createdMs) : null;

    const modelObject = record(data.model);
    const model = name(data.modelID) ?? name(data.modelId) ?? name(data.model) ?? name(modelObject?.id) ?? name(modelObject?.modelID);
    const completedAt = Number.isFinite(completedMs) && completedMs > 0 ? completedMs
      : Number.isFinite(endMs) && endMs > 0 ? endMs : time(row.time_created);
    if (!Number.isFinite(completedAt)) continue;

    const entry = buildRecord({
      id: `opencode_session:${rowId}`,
      rawId: rowId,
      completedAt,
      createdAtSec: Number.isFinite(createdMs) && createdMs > 0 ? Math.floor(createdMs / 1000) : Math.floor(completedAt / 1000),
      dataSource: 'opencode_session',
      inputTokens: input,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheWrite,
      cacheInclusive: false,
      outputTokens: totalOutput,
      durationMs,
      model
    });
    if (entry) byId.set(entry.id, entry);
  }
  return recentRecords([...byId.values()]);
}

export function buildProxyRecord(row) {
  const r = record(row);
  if (!r) return null;
  const requestId = name(r.request_id);
  const createdAtSec = typeof r.created_at === 'number' && Number.isFinite(r.created_at) ? Math.floor(r.created_at) : null;
  if (!requestId || createdAtSec === null) return null;
  const cacheInclusive = r.input_token_semantics === 1 || r.app_type === 'grokbuild';
  const effectiveModel = name(r.pricing_model) ?? name(r.model) ?? name(r.request_model);
  const entry = buildRecord({
    id: `proxy:${requestId}`,
    rawId: requestId,
    completedAt: createdAtSec * 1000,
    createdAtSec,
    dataSource: 'proxy',
    inputTokens: count(r.input_tokens) ?? 0,
    cacheReadTokens: count(r.cache_read_tokens) ?? 0,
    cacheCreationTokens: count(r.cache_creation_tokens) ?? 0,
    cacheInclusive,
    outputTokens: count(r.output_tokens) ?? 0,
    durationMs: count(r.latency_ms),
    firstTokenMs: count(r.first_token_ms),
    model: effectiveModel
  });
  if (!entry) return null;
  return {
    ...entry,
    sessionId: name(r.session_id),
    proxyModel: name(r.model),
    proxyRequestModel: name(r.request_model)
  };
}

function modelsMatchForDedup(proxyEntry, sessionEntry, provider) {
  const pModel = (proxyEntry.model ?? proxyEntry.proxyModel ?? '').toLowerCase();
  const sModel = (sessionEntry.model ?? '').toLowerCase();
  if (!pModel || !sModel || pModel === 'unknown' || sModel === 'unknown') return true;
  if (pModel === sModel) return true;
  if (provider === 'codex') {
    const reqModel = (proxyEntry.proxyRequestModel ?? '').toLowerCase();
    if (reqModel && reqModel !== 'unknown' && (reqModel === sModel || normalizeCodexModel(reqModel) === normalizeCodexModel(sModel))) return true;
    if (normalizeCodexModel(pModel) === normalizeCodexModel(sModel)) return true;
  }
  return false;
}

function stripProxyInternalFields(entry) {
  const { sessionId: _s, proxyModel: _pm, proxyRequestModel: _prm, ...clean } = entry;
  return clean;
}

/** Deduplicate session-log records against 2xx CC Switch local-proxy logs (exact ID or ±600s semantic match). */
export function mergeProxyRecords(sessionRecords, proxyRows, provider, targetSessionId) {
  if (!Array.isArray(proxyRows) || !proxyRows.length) return recentRecords(sessionRecords);
  const parsedProxy = proxyRows.map(buildProxyRecord).filter(Boolean);
  if (!parsedProxy.length) return recentRecords(sessionRecords);

  const usedProxyIds = new Set();
  const merged = [];

  for (const sRec of sessionRecords) {
    if (!sRec) continue;
    let matched = parsedProxy.find(p => !usedProxyIds.has(p.id) && sRec.rawId && p.rawId === sRec.rawId);
    if (!matched) {
      matched = parsedProxy.find(p =>
        !usedProxyIds.has(p.id) &&
        (!p.sessionId || !targetSessionId || p.sessionId === targetSessionId) &&
        Math.abs(p.createdAtSec - sRec.createdAtSec) <= SESSION_PROXY_DEDUP_WINDOW_SECONDS &&
        p.freshInputTokens === sRec.freshInputTokens &&
        p.outputTokens === sRec.outputTokens &&
        p.cacheReadTokens === sRec.cacheReadTokens &&
        p.cacheCreationTokens === sRec.cacheCreationTokens &&
        modelsMatchForDedup(p, sRec, provider)
      );
    }
    if (matched) {
      usedProxyIds.add(matched.id);
      const completedAt = Math.abs(matched.completedAt - sRec.completedAt) < 2000 ? sRec.completedAt : matched.completedAt;
      merged.push(stripProxyInternalFields({
        ...matched,
        completedAt,
        ...(sRec.isSubagent ? { isSubagent: true } : {})
      }));
    } else {
      merged.push(sRec);
    }
  }

  for (const p of parsedProxy) {
    if (!usedProxyIds.has(p.id) && targetSessionId && p.sessionId === targetSessionId) {
      merged.push(stripProxyInternalFields(p));
    }
  }

  return recentRecords(merged);
}
