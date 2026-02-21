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
 *   NOTE: agent_end.durationMs = total agent turn wall-time (includes tool calls,
 *   all LLM round-trips, etc.).  True per-LLM-call latency is measured here by
 *   stamping Date.now() at llm_input and diffing at llm_output.
 *
 *   NOTE: There is no llm_error event.  If a LLM call fails, llm_output never
 *   fires; the in-flight gauge is decremented at agent_end (best-effort cleanup
 *   for the affected session).
 *
 * ─── Example scrape output ────────────────────────────────────────────────────
 *
 *   openclaw_llm_in_flight{provider="anthropic",model="claude-sonnet-4-6"} 1
 *   openclaw_llm_requests_sent_total{provider="anthropic",model="claude-sonnet-4-6"} 4
 *   openclaw_llm_duration_seconds_sum{provider="anthropic",model="claude-sonnet-4-6",status="success"} 143.489
 *   openclaw_llm_duration_seconds_count{provider="anthropic",model="claude-sonnet-4-6",status="success"} 3
 *   openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="input"} 118
 *   openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="output"} 6497
 *   openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="cache_read"} 1504043
 *   openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="cache_write"} 383190
 *   openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="total"} 1893848
 *   openclaw_agent_turns_in_flight{agent_id="main"} 1
 *   openclaw_agent_turn_duration_seconds_sum{agent_id="main",status="success"} 143.468
 *   openclaw_agent_turn_duration_seconds_count{agent_id="main",status="success"} 3
 *   openclaw_agent_turns_total{status="all"}   3
 *   openclaw_agent_turns_total{status="error"} 0
 */

// ─── Internal state ──────────────────────────────────────────────────────────

const metrics = {
  // key: string  "provider:model"            e.g. "anthropic:claude-sonnet-4-6"
  // val: number  integer, current in-flight  e.g. 2
  llmInFlight: new Map(),

  // key: string  "provider:model"            e.g. "google:gemini-2.5-flash"
  // val: number  integer, cumulative total   e.g. 47
  llmSent: new Map(),

  // key: string  "provider:model:status"     e.g. "anthropic:claude-sonnet-4-6:success"
  // val: number  float ms, running sum       e.g. 18432.5   (convert to seconds on output)
  llmDurationSum: new Map(),

  // key: string  "provider:model:status"     e.g. "anthropic:claude-sonnet-4-6:success"
  // val: number  integer, observation count  e.g. 12
  llmDurationCount: new Map(),

  // key: string  "provider:model:token_type"  e.g. "anthropic:claude-sonnet-4-6:input"
  //              token_type ∈ { input, output, cache_read, cache_write, total }
  // val: number  integer, cumulative tokens  e.g. 128000
  tokens: new Map(),

  // key: string  agentId                              e.g. "main"
  // val: Set<string>  Set of in-flight sessionIds     e.g. Set { "b2fd966f-...", "a1b2c3-..." }
  // Using Set (not a counter) because before_agent_start fires twice per turn for the same
  // sessionId; Set.add() deduplicates so the reported size stays correct.
  agentInFlight: new Map(),

  // key: string  "agentId:status"            e.g. "main:success"
  //              status ∈ { success, error }
  // val: number  float ms, running sum       e.g. 95100.0  (convert to seconds on output)
  agentDurationSum: new Map(),

  // key: string  "agentId:status"            e.g. "main:error"
  // val: number  integer, observation count  e.g. 3
  agentDurationCount: new Map(),

  // Scalar counters; reset to 0 at every gateway_start
  // total:  integer, all agent turns completed   e.g. 42
  // errors: integer, failed agent turns          e.g. 1
  agentTurns: { total: 0, errors: 0 },

  // Temporary scratch — populated at llm_input, deleted at llm_output
  // key: string  runId (UUID from llm_input event)  e.g. "36ed040d-2422-49d6-96fb-858212694bf3"
  // val: object  { startMs: number (Date.now() ms), provider: string, model: string }
  //              e.g. { startMs: 1740160000000, provider: "anthropic", model: "claude-sonnet-4-6" }
  llmStartTimes: new Map(),

  // Temporary scratch — updated at llm_input, deleted at agent_end (error path only)
  // key: string  sessionId (UUID from event ctx)  e.g. "b2fd966f-2cd6-4ab2-a37e-ec5e22312fe4"
  // val: object  { provider: string, model: string }
  //              e.g. { provider: "google", model: "gemini-2.5-flash" }
  // Purpose: lets agent_end(error) find which provider:model to clear from llmInFlight
  sessionLastModel: new Map(),

  // Rolling debug event log; last 20 entries; surfaced as # comments in /metrics output
  // Each entry: string  e.g. "2026-02-21T18:38:07.010Z llm_input runId=36ed... anthropic/claude-sonnet-4-6"
  events: [],
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
  if (metrics.events.length > 20) metrics.events.shift();
}

// ─── Prometheus text output ──────────────────────────────────────────────────

function labels(obj) {
  const pairs = Object.entries(obj).map(([k, v]) => `${k}="${v}"`).join(',');
  return pairs ? `{${pairs}}` : '';
}

function generateMetrics() {
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

  // Debug event log
  for (const e of metrics.events.slice(-10)) {
    lines.push(`# ${e}`);
  }

  return lines.join('\n') + '\n';
}

// ─── Plugin entry point ──────────────────────────────────────────────────────

export default function(api) {
  api.logger.info('Prometheus exporter loaded');

  // ── /metrics HTTP endpoint ─────────────────────────────────────────────────
  api.registerHttpRoute({
    path: '/metrics',
    handler: async (req, res) => {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.end(generateMetrics());
    }
  });

  // ── gateway_start: reset per-startup counters + stuck gauges ──────────────
  // Called once on every gateway process start.
  api.on('gateway_start', () => {
    metrics.llmInFlight.clear();       // clear any stuck in-flight from previous run
    metrics.agentInFlight.clear();
    metrics.llmStartTimes.clear();
    metrics.sessionLastModel.clear();
    metrics.agentTurns.total  = 0;
    metrics.agentTurns.errors = 0;
    logEvent('gateway_start - reset counters');
  });

  // ── before_agent_start: agent turn begins ─────────────────────────────────
  // evt: { prompt, messages? }
  // ctx: { agentId?, sessionKey?, sessionId?, ... }
  api.on('before_agent_start', (evt, ctx) => {
    const agentId   = ctx?.agentId   || 'unknown';
    const sessionId = ctx?.sessionId || 'unknown';
    // Set.add() is idempotent — fires-twice problem doesn't inflate the count
    if (!metrics.agentInFlight.has(agentId)) metrics.agentInFlight.set(agentId, new Set());
    metrics.agentInFlight.get(agentId).add(sessionId);
    logEvent(`before_agent_start agentId=${agentId} sessionId=${sessionId}`);
  });

  // ── llm_input: one LLM API call is about to be sent ───────────────────────
  // evt: { runId, sessionId, provider, model, ... }
  // ctx: { agentId?, sessionId?, ... }
  api.on('llm_input', (evt) => {
    const { runId, sessionId, provider, model } = evt;
    const modelKey = key(provider, model);

    // Gauge: this LLM call is now in-flight
    gaugeDelta(metrics.llmInFlight, modelKey, +1);

    // Counter: total LLM calls ever sent
    inc(metrics.llmSent, modelKey);

    // Stamp start time for latency calculation at llm_output
    metrics.llmStartTimes.set(runId, { startMs: Date.now(), provider, model });

    // Record latest model for this session (used for stuck-gauge cleanup at agent_end)
    if (sessionId) metrics.sessionLastModel.set(sessionId, { provider, model });

    logEvent(`llm_input  runId=${runId} sessionId=${sessionId} ${provider}/${model}`);
  });

  // ── llm_output: LLM API call returned successfully ────────────────────────
  // evt: { runId, sessionId, provider, model, usage?, assistantTexts, ... }
  api.on('llm_output', (evt) => {
    const { runId, sessionId, provider, model, usage } = evt;
    const modelKey = key(provider, model);

    // Gauge: this LLM call is no longer in-flight
    gaugeDelta(metrics.llmInFlight, modelKey, -1);

    // Compute and record per-LLM-call latency
    const startEntry = metrics.llmStartTimes.get(runId);
    if (startEntry) {
      const durationMs = Date.now() - startEntry.startMs;
      const dKey = key(provider, model, 'success');
      inc(metrics.llmDurationSum,   dKey, durationMs);
      inc(metrics.llmDurationCount, dKey, 1);
      metrics.llmStartTimes.delete(runId);
    }

    // Token usage counters
    if (usage) {
      if (usage.input)      inc(metrics.tokens, key(provider, model, 'input'),       usage.input);
      if (usage.output)     inc(metrics.tokens, key(provider, model, 'output'),      usage.output);
      if (usage.cacheRead)  inc(metrics.tokens, key(provider, model, 'cache_read'),  usage.cacheRead);
      if (usage.cacheWrite) inc(metrics.tokens, key(provider, model, 'cache_write'), usage.cacheWrite);
      if (usage.total)      inc(metrics.tokens, key(provider, model, 'total'),       usage.total);
    }

    logEvent(`llm_output runId=${runId} sessionId=${sessionId} ${provider}/${model}`);
  });

  // ── agent_end: one full agent turn completed ───────────────────────────────
  // evt: { messages, success, error?, durationMs? }   — no runId, no provider
  // ctx: { agentId?, sessionKey?, sessionId?, ... }
  api.on('agent_end', (evt, ctx) => {
    const { success, error, durationMs } = evt;
    const agentId   = ctx?.agentId   || 'unknown';
    const sessionId = ctx?.sessionId;
    const status    = (error || !success) ? 'error' : 'success';

    // Gauge: remove this session from the in-flight Set
    metrics.agentInFlight.get(agentId)?.delete(sessionId);

    // Agent turn counters
    metrics.agentTurns.total++;
    if (status === 'error') metrics.agentTurns.errors++;

    // Agent turn wall-time (total turn duration including all tool calls + LLM round-trips)
    if (durationMs) {
      const dKey = key(agentId, status);
      inc(metrics.agentDurationSum,   dKey, durationMs);
      inc(metrics.agentDurationCount, dKey, 1);
    }

    // Error-path cleanup: if LLM calls went in-flight but llm_output never fired
    // (e.g. network error), clean up residual in-flight entries for this session.
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

    logEvent(`agent_end  agentId=${agentId} sessionId=${sessionId} ${status} ${durationMs}ms`);
  });

  // Reset state on startup (also handled above in gateway_start event, but
  // this runs synchronously before any requests arrive)
  metrics.llmInFlight.clear();
  metrics.agentInFlight.clear();
  metrics.agentTurns.total  = 0;
  metrics.agentTurns.errors = 0;
  logEvent('gateway_start - reset counters');

  api.logger.info('Prometheus ready at /metrics');
}
