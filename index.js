/**
 * openclaw-prometheus-plugin
 *
 * Exposes OpenClaw LLM metrics in Prometheus text format at /metrics endpoint.
 *
 * ─── Event lifecycle pairs ────────────────────────────────────────────────────
 *
 *   LLM call:    llm_input  ──►  llm_output
 *                (evt: runId, sessionId, provider, model, ...)
 *                (evt: runId, sessionId, provider, model, usage, ...)
 *
 *   Agent turn:  before_agent_start  ──►  agent_end
 *                (ctx: agentId, sessionId, ...)
 *                (evt: messages, success, error?, durationMs?; ctx: agentId, sessionId, ...)
 *
 * ─── Cost estimation ──────────────────────────────────────────────────────────
 *
 *   Pricing uses a two-layer fallback:
 *   1. ~/.openclaw/llm-pricing.json  — hot-reloadable user overrides (highest priority)
 *   2. OpenRouter /api/v1/models     — fetched once at startup, cached in memory
 *
 *   New metric:
 *     openclaw_estimated_cost_dollars_total{provider, model, token_type}
 *     token_type ∈ { input, output, cache_write, cache_read, total }
 *   Units: USD (dollars)
 *
 * ─── Persistence across restarts ──────────────────────────────────────────────
 *
 *   Cumulative counters (tokens + cost) persisted to prometheus-snapshot.json.
 *
 * ─── Input token normalization ────────────────────────────────────────────────
 *
 *   Providers differ in how `usage.input` is reported when prompt caching is active:
 *
 *   GROSS reporters — `input` = full prompt size (cached tokens included):
 *     - google/*          (Gemini family, verified 2026-02-24)
 *     - minimax-portal/*  (MiniMax M2.x, verified 2026-02-24)
 *
 *   NET reporters — `input` = new (uncached) tokens only:
 *     - anthropic/*       (Claude family)
 *     - openrouter/*      (inherits the upstream provider's style, but OpenRouter
 *                          normalizes to net before returning — treat as net)
 *     - openai/*          (GPT family, no prompt caching as of 2026-02)
 *     - xai/*             (Grok family, no prompt caching as of 2026-02)
 *
 *   The function resolveNetInput() encodes this knowledge explicitly.
 *   `input_net` metric always represents "new tokens actually processed" regardless
 *   of provider, and is used for cost estimation to avoid over-counting.
 *
 *   MAINTENANCE NOTE: if a provider changes their reporting style, update
 *   GROSS_INPUT_PROVIDERS below and add a comment with the date + evidence.
 *
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

// ─── Persistence paths ────────────────────────────────────────────────────────

const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME, '.openclaw');
const SNAPSHOT_PATH = path.join(stateDir, 'prometheus-snapshot.json');
const PRICING_PATH  = path.join(stateDir, 'llm-pricing.json');

// ─── Input token normalization ────────────────────────────────────────────────

/**
 * Providers that report `usage.input` as GROSS (full prompt, cached tokens included).
 * All others are assumed to report NET (new tokens only).
 *
 * Key format: "provider" (matches the OpenClaw provider field, e.g. "google").
 * To add a new gross reporter, append to this Set and note the date + source.
 */
const GROSS_INPUT_PROVIDERS = new Set([
  'google',         // Gemini family — promptTokenCount includes cachedContentTokenCount
                    // Verified 2026-02-24 via observed usage data
  'minimax-portal', // MiniMax M2.x — input field includes cache_read tokens
                    // Verified 2026-02-24 via observed usage data
]);

/**
 * Resolves the "net input" token count — i.e. newly processed (non-cached) tokens.
 *
 * For GROSS reporters: net = max(0, input - cacheRead)
 * For NET reporters:   net = input  (already correct)
 *
 * @param {string} provider  - OpenClaw provider id (e.g. "google", "anthropic")
 * @param {object} usage     - Raw usage object from llm_output event
 * @returns {{ netInput: number, inputStyle: 'gross'|'net' }}
 */
function resolveNetInput(provider, usage) {
  const rawInput  = usage.input     || 0;
  const cacheRead = usage.cacheRead || 0;

  if (GROSS_INPUT_PROVIDERS.has(provider)) {
    return {
      netInput:   Math.max(0, rawInput - cacheRead),
      inputStyle: 'gross',
    };
  }

  return {
    netInput:   rawInput,
    inputStyle: 'net',
  };
}

// ─── Pricing ──────────────────────────────────────────────────────────────────
// All prices in $ per 1M tokens (MTok).
// Two layers: pricingOverrides (from file, hot-reloadable) + orPricing (OpenRouter cache).

let pricingOverrides = {};   // from llm-pricing.json
let orPricing = {};          // from OpenRouter API, keyed by OR model id (e.g. "anthropic/claude-3-5-sonnet")
let pricingWatcher = null;

function loadPricingFile() {
  try {
    const raw = fsSync.readFileSync(PRICING_PATH, 'utf8');
    pricingOverrides = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[pricing] Failed to load ${PRICING_PATH}: ${err.message}`);
    }
    pricingOverrides = {};
  }
}

async function fetchOpenRouterPricing() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data } = await res.json();
    orPricing = {};
    for (const m of data) {
      const p = m.pricing || {};
      // OpenRouter pricing fields are strings in $ per token → convert to $ per MTok
      orPricing[m.id] = {
        input:       parseFloat(p.prompt      || 0) * 1_000_000,
        output:      parseFloat(p.completion  || 0) * 1_000_000,
        cache_write: parseFloat(p.input_cache_write || p.cache_creation_input_tokens || 0) * 1_000_000,
        cache_read:  parseFloat(p.input_cache_read  || p.cache_read_input_tokens     || 0) * 1_000_000,
      };
    }
    logEvent(`pricing - loaded ${Object.keys(orPricing).length} models from OpenRouter`);
  } catch (err) {
    logEvent(`pricing - OpenRouter fetch failed: ${err.message}`);
  }
}

// Returns pricing object { input, output, cache_write, cache_read } for a given provider:model key.
// All values in $ per MTok. Returns null if no pricing found.
function getPricing(provider, model) {
  const pluginKey = `${provider}:${model}`;

  // Layer 1: user override file
  if (pricingOverrides[pluginKey]) return pricingOverrides[pluginKey];

  // Layer 2: OpenRouter cache
  // OpenRouter uses dots in version numbers (e.g. claude-sonnet-4.6) while OpenClaw
  // normalizes to hyphens (claude-sonnet-4-6). Try both forms.
  const orBase = provider === 'openrouter' ? model : `${provider}/${model}`;
  // Try exact match first, then hyphen→dot normalization on the last segment
  const orKeyDot = orBase.replace(/-(\d+)$/, '.$1');
  for (const orKey of [orBase, orKeyDot]) {
    if (orPricing[orKey]) return orPricing[orKey];
  }

  return null; // unknown → cost = 0
}

// ─── Internal state ──────────────────────────────────────────────────────────

const metrics = {
  llmInFlight:        new Map(),
  llmSent:            new Map(),
  llmDurationSum:     new Map(),
  llmDurationCount:   new Map(),
  tokens:             new Map(),

  // key: "provider:model:token_type"  token_type ∈ { input, output, cache_write, cache_read, total }
  // val: number  cumulative USD cost
  cost:               new Map(),

  agentInFlight:      new Map(),
  agentDurationSum:   new Map(),
  agentDurationCount: new Map(),
  agentTurns:         { total: 0, errors: 0 },

  // Scratch maps (not persisted)
  llmStartTimes:      new Map(),
  sessionLastModel:   new Map(),

  events:             [],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function key(...parts) { return parts.join(':'); }

function inc(map, k, v = 1) { map.set(k, (map.get(k) || 0) + v); }
function gauge(map, k, v)   { map.set(k, v); }
function gaugeDelta(map, k, delta, min = 0) {
  map.set(k, Math.max(min, (map.get(k) || 0) + delta));
}

function logEvent(msg) {
  metrics.events.push(`${new Date().toISOString()} ${msg}`);
  if (metrics.events.length > 1000) metrics.events.shift();
}

// Accumulate cost for a single token type. price is $ per MTok, tokens is count.
function incCost(provider, model, tokenType, tokens, pricePerMTok) {
  if (!tokens || !pricePerMTok) return 0;
  const cost = (tokens / 1_000_000) * pricePerMTok;
  inc(metrics.cost, key(provider, model, tokenType), cost);
  return cost;
}

// ─── Prometheus text output ──────────────────────────────────────────────────

function labels(obj) {
  const pairs = Object.entries(obj).map(([k, v]) => `${k}="${v}"`).join(',');
  return pairs ? `{${pairs}}` : '';
}

function generateMetrics(maxEventLines = 0) {
  const lines = [];

  // LLM in-flight gauge
  for (const [k, v] of metrics.llmInFlight) {
    const [provider, model] = k.split(':');
    lines.push(`openclaw_llm_in_flight${labels({ provider, model })} ${v}`);
  }

  // LLM requests sent (cumulative)
  for (const [k, v] of metrics.llmSent) {
    const [provider, model] = k.split(':');
    lines.push(`openclaw_llm_requests_sent_total${labels({ provider, model })} ${v}`);
  }

  // LLM call duration (sum + count)
  for (const [k, sum] of metrics.llmDurationSum) {
    const [provider, model, status] = k.split(':');
    const count = metrics.llmDurationCount.get(k) || 1;
    lines.push(`openclaw_llm_duration_seconds_sum${labels({ provider, model, status })} ${(sum / 1000).toFixed(3)}`);
    lines.push(`openclaw_llm_duration_seconds_count${labels({ provider, model, status })} ${count}`);
  }

  // Token counters
  for (const [k, v] of metrics.tokens) {
    const [provider, model, token_type] = k.split(':');
    lines.push(`openclaw_llm_tokens_total${labels({ provider, model, token_type })} ${v}`);
  }

  // Estimated cost counters
  for (const [k, v] of metrics.cost) {
    const [provider, model, token_type] = k.split(':');
    lines.push(`openclaw_estimated_cost_dollars_total${labels({ provider, model, token_type })} ${v.toFixed(6)}`);
  }

  // Agent turn in-flight gauge (val is a Set; report its size)
  for (const [k, v] of metrics.agentInFlight) {
    lines.push(`openclaw_agent_turns_in_flight${labels({ agent_id: k })} ${v.size}`);
  }

  // Agent turn duration (sum + count)
  for (const [k, sum] of metrics.agentDurationSum) {
    const lastColon = k.lastIndexOf(':');
    const agent_id = k.slice(0, lastColon);
    const status   = k.slice(lastColon + 1);
    const count = metrics.agentDurationCount.get(k) || 1;
    lines.push(`openclaw_agent_turn_duration_seconds_sum${labels({ agent_id, status })} ${(sum / 1000).toFixed(3)}`);
    lines.push(`openclaw_agent_turn_duration_seconds_count${labels({ agent_id, status })} ${count}`);
  }

  // Agent turns total (since last gateway start)
  lines.push(`openclaw_agent_turns_total${labels({ status: 'all' })}   ${metrics.agentTurns.total}`);
  lines.push(`openclaw_agent_turns_total${labels({ status: 'error' })} ${metrics.agentTurns.errors}`);

  // Event log
  if (maxEventLines > 0) {
    const numLines = Math.min(maxEventLines, 1000);
    for (const e of metrics.events.slice(-numLines)) {
      lines.push(`# ${e}`);
    }
  }

  return lines.join('\n') + '\n';
}

// ─── Snapshot persistence ────────────────────────────────────────────────────

function saveSnapshotSync() {
  const snapshot = {
    timestamp: Date.now(),
    version: 2,
    llmSent:            Object.fromEntries(metrics.llmSent),
    llmDurationSum:     Object.fromEntries(metrics.llmDurationSum),
    llmDurationCount:   Object.fromEntries(metrics.llmDurationCount),
    tokens:             Object.fromEntries(metrics.tokens),
    cost:               Object.fromEntries(metrics.cost),
    agentDurationSum:   Object.fromEntries(metrics.agentDurationSum),
    agentDurationCount: Object.fromEntries(metrics.agentDurationCount),
    agentTurns:         { ...metrics.agentTurns },
  };
  fsSync.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

async function loadSnapshot() {
  try {
    const raw  = await fs.readFile(SNAPSHOT_PATH, 'utf8');
    const data = JSON.parse(raw);

    for (const [k, v] of Object.entries(data.llmSent            || {})) metrics.llmSent.set(k, v);
    for (const [k, v] of Object.entries(data.llmDurationSum     || {})) metrics.llmDurationSum.set(k, v);
    for (const [k, v] of Object.entries(data.llmDurationCount   || {})) metrics.llmDurationCount.set(k, v);
    for (const [k, v] of Object.entries(data.tokens             || {})) metrics.tokens.set(k, v);
    for (const [k, v] of Object.entries(data.cost               || {})) metrics.cost.set(k, v);
    for (const [k, v] of Object.entries(data.agentDurationSum   || {})) metrics.agentDurationSum.set(k, v);
    for (const [k, v] of Object.entries(data.agentDurationCount || {})) metrics.agentDurationCount.set(k, v);

    metrics.agentTurns.total  = data.agentTurns?.total  || 0;
    metrics.agentTurns.errors = data.agentTurns?.errors || 0;

    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to load snapshot: ${err.message}`);
  }
}

// ─── Plugin entry point ──────────────────────────────────────────────────────

const AUTO_SAVE_INTERVAL_MS = 30000;
let autoSaveTimer = null;
let isDirty = false;

export default function(api) {
  api.logger.info('Prometheus exporter loaded');

  // ── /metrics HTTP endpoint ─────────────────────────────────────────────────
  api.registerHttpRoute({
    path: '/metrics',
    auth: 'plugin', // No gateway auth required for Prometheus scraping
    match: 'exact',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const linesParam = url.searchParams.get('lines');
      const maxEventLines = linesParam ? Math.max(1, Math.min(parseInt(linesParam, 10), 1000)) : 0;
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.end(generateMetrics(maxEventLines));
      return true; // Indicate route handled the request
    }
  });

  // ── gateway_start ──────────────────────────────────────────────────────────
  api.on('gateway_start', async () => {
    // Restore persisted counters
    const snapshot = await loadSnapshot();
    if (snapshot) {
      const ageSec = ((Date.now() - snapshot.timestamp) / 1000).toFixed(1);
      api.logger.info(`Restored metrics snapshot (age: ${ageSec}s, path: ${SNAPSHOT_PATH})`);
      logEvent(`gateway_start - restored snapshot (age ${ageSec}s)`);
    } else {
      api.logger.info('No metrics snapshot found, starting fresh');
      logEvent('gateway_start - no snapshot (fresh start)');
    }

    // Clear transient gauges
    metrics.llmInFlight.clear();
    metrics.agentInFlight.clear();
    metrics.llmStartTimes.clear();
    metrics.sessionLastModel.clear();

    for (const k of metrics.llmSent.keys()) metrics.llmInFlight.set(k, 0);

    const knownAgentIds = new Set();
    for (const k of metrics.agentDurationSum.keys()) {
      knownAgentIds.add(k.slice(0, k.lastIndexOf(':')));
    }
    for (const agentId of knownAgentIds) {
      metrics.agentInFlight.set(agentId, new Set());
    }

    // Load pricing file (Layer 1)
    loadPricingFile();
    try {
      pricingWatcher = fsSync.watch(PRICING_PATH, () => {
        loadPricingFile();
        logEvent(`pricing - reloaded from ${PRICING_PATH}`);
        api.logger.info(`Pricing file reloaded: ${PRICING_PATH}`);
      });
    } catch {
      // File may not exist yet; watcher will be created when file is first written
    }

    // Fetch OpenRouter pricing (Layer 2, non-blocking)
    fetchOpenRouterPricing().then(() => {
      api.logger.info(`OpenRouter pricing loaded (${Object.keys(orPricing).length} models)`);
    });
  });

  // ── before_agent_start ────────────────────────────────────────────────────
  api.on('before_agent_start', (evt, ctx) => {
    const agentId   = ctx?.agentId   || 'unknown';
    const sessionId = ctx?.sessionId || 'unknown';
    if (!metrics.agentInFlight.has(agentId)) metrics.agentInFlight.set(agentId, new Set());
    metrics.agentInFlight.get(agentId).add(sessionId);
    logEvent(`before_agent_start agentId=${agentId} sessionId=${sessionId}`);
  });

  // ── llm_input ─────────────────────────────────────────────────────────────
  api.on('llm_input', (evt) => {
    const { runId, sessionId, provider, model } = evt;
    const modelKey = key(provider, model);

    gaugeDelta(metrics.llmInFlight, modelKey, +1);
    inc(metrics.llmSent, modelKey);
    metrics.llmStartTimes.set(runId, { startMs: Date.now(), provider, model });
    if (sessionId) metrics.sessionLastModel.set(sessionId, { provider, model });

    isDirty = true;
    logEvent(`llm_input  runId=${runId} sessionId=${sessionId} ${provider}/${model}`);
  });

  // ── llm_output ────────────────────────────────────────────────────────────
  api.on('llm_output', (evt) => {
    const { runId, sessionId, provider, model, usage, assistantTexts } = evt;
    const modelKey = key(provider, model);

    gaugeDelta(metrics.llmInFlight, modelKey, -1);

    const startEntry = metrics.llmStartTimes.get(runId);
    if (startEntry) {
      const durationMs = Date.now() - startEntry.startMs;
      const dKey = key(provider, model, 'success');
      inc(metrics.llmDurationSum,   dKey, durationMs);
      inc(metrics.llmDurationCount, dKey, 1);
      metrics.llmStartTimes.delete(runId);
    }

    if (usage) {
      const rawInput  = usage.input      || 0;
      const rawOutput = usage.output     || 0;
      const rawCache  = usage.cacheRead  || 0;
      const rawWrite  = usage.cacheWrite || 0;
      const rawTotal  = usage.total      || 0;

      // Resolve net input — see resolveNetInput() and GROSS_INPUT_PROVIDERS for details
      const { netInput, inputStyle } = resolveNetInput(provider, usage);

      if (rawInput)  inc(metrics.tokens, key(provider, model, 'input'),       rawInput);
      if (rawOutput) inc(metrics.tokens, key(provider, model, 'output'),      rawOutput);
      if (rawCache)  inc(metrics.tokens, key(provider, model, 'cache_read'),  rawCache);
      if (rawWrite)  inc(metrics.tokens, key(provider, model, 'cache_write'), rawWrite);
      if (rawTotal)  inc(metrics.tokens, key(provider, model, 'total'),       rawTotal);
      // input_net = new tokens actually processed (normalized across all providers)
      inc(metrics.tokens, key(provider, model, 'input_net'), netInput);

      // ── Cost estimation — always use input_net, never raw input ─────────
      const price = getPricing(provider, model);
      if (price) {
        let totalCost = 0;
        totalCost += incCost(provider, model, 'input',       netInput,  price.input);
        totalCost += incCost(provider, model, 'output',      rawOutput, price.output);
        totalCost += incCost(provider, model, 'cache_write', rawWrite,  price.cache_write);
        totalCost += incCost(provider, model, 'cache_read',  rawCache,  price.cache_read);
        if (totalCost > 0) inc(metrics.cost, key(provider, model, 'total'), totalCost);
      } else {
        logEvent(`pricing - no price for ${provider}/${model}, cost not tracked`);
      }

      logEvent(`llm_output ${provider}/${model} style=${inputStyle} input=${rawInput} net=${netInput} cache=${rawCache} output=${rawOutput}`);
    }

    isDirty = true;
    const usageStr = usage ? `usage=${JSON.stringify(usage)}` : 'usage=none';
    const textLen = Array.isArray(assistantTexts) ? assistantTexts.reduce((s, t) => s + t.length, 0) : 0;
    logEvent(`llm_output runId=${runId} sessionId=${sessionId} ${provider}/${model} ${usageStr} textLen=${textLen}`);
  });

  // ── agent_end ─────────────────────────────────────────────────────────────
  api.on('agent_end', (evt, ctx) => {
    const { success, error, durationMs } = evt;
    const agentId   = ctx?.agentId   || 'unknown';
    const sessionId = ctx?.sessionId;
    const status    = (error || !success) ? 'error' : 'success';

    metrics.agentInFlight.get(agentId)?.delete(sessionId);
    metrics.agentTurns.total++;
    if (status === 'error') metrics.agentTurns.errors++;

    if (durationMs) {
      const dKey = key(agentId, status);
      inc(metrics.agentDurationSum,   dKey, durationMs);
      inc(metrics.agentDurationCount, dKey, 1);
    }

    if (status === 'error' && sessionId) {
      const lastModel = metrics.sessionLastModel.get(sessionId);
      if (lastModel) {
        const modelKey = key(lastModel.provider, lastModel.model);
        const stuck = metrics.llmInFlight.get(modelKey) || 0;
        if (stuck > 0) {
          gauge(metrics.llmInFlight, modelKey, 0);
          logEvent(`agent_end error-cleanup: cleared ${stuck} stuck in-flight for ${modelKey}`);
        }
      }
      metrics.sessionLastModel.delete(sessionId);
    }

    isDirty = true;
    const errorStr = error ? ` error=${JSON.stringify(error)}` : '';
    logEvent(`agent_end  agentId=${agentId} sessionId=${sessionId} ${status} ${durationMs}ms${errorStr}`);
  });

  // ── gateway_stop ──────────────────────────────────────────────────────────
  api.on('gateway_stop', (evt) => {
    const reason = evt?.reason || 'unknown';

    if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null; }
    if (pricingWatcher) { pricingWatcher.close(); pricingWatcher = null; }

    try {
      saveSnapshotSync();
      const counters = { llmSent: metrics.llmSent.size, tokens: metrics.tokens.size, agentTurns: metrics.agentTurns.total };
      api.logger.info(`Saved metrics snapshot: ${JSON.stringify(counters)} (reason: ${reason})`);
      logEvent(`gateway_stop - saved snapshot (${counters.llmSent} models, ${counters.agentTurns} turns)`);
    } catch (err) {
      api.logger.error(`Failed to save metrics snapshot: ${err.message}`);
      logEvent(`gateway_stop - ERROR: ${err.message}`);
    }
  });

  // ── Auto-save timer ────────────────────────────────────────────────────────
  autoSaveTimer = setInterval(() => {
    if (!isDirty) return;
    try {
      saveSnapshotSync();
      isDirty = false;
      const counters = { llmSent: metrics.llmSent.size, tokens: metrics.tokens.size, agentTurns: metrics.agentTurns.total };
      logEvent(`auto-save - saved snapshot (${counters.llmSent} models, ${counters.agentTurns} turns)`);
    } catch (err) {
      api.logger.warn(`Auto-save failed: ${err.message}`);
      logEvent(`auto-save - ERROR: ${err.message}`);
    }
  }, AUTO_SAVE_INTERVAL_MS);

  api.logger.info(`Prometheus plugin loaded, /metrics endpoint ready (auto-save every ${AUTO_SAVE_INTERVAL_MS / 1000}s)`);
}
