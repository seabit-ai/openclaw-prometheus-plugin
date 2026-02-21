/**
 * openclaw-prometheus-plugin
 * 
 * Exposes OpenClaw LLM metrics in Prometheus text format at /metrics endpoint.
 * Uses the llm_output hook which runs in the main bundle (no event bus isolation issues).
 * 
 * Install: openclaw plugins install --link ~/src/seabit-ai/openclaw-prometheus-plugin
 */

const counters = {
  // tokens by provider, model, token_type
  tokens: new Map(),  // key: "provider:model:token_type" → number
  
  // cost by provider, model
  cost: new Map(),    // key: "provider:model" → number (USD)
  
  // duration by provider, model
  duration: {
    sum: new Map(),    // key: "provider:model" → total ms
    count: new Map(), // key: "provider:model" → call count
  },
  
  // total requests
  requests: {
    total: 0,
    errors: 0,
  }
};

function makeKey(parts) {
  return parts.join(':');
}

function incCounter(map, key, value = 1) {
  map.set(key, (map.get(key) || 0) + value);
}

/**
 * Generate Prometheus text format output
 */
function generateMetrics() {
  const lines = [];
  const now = Math.floor(Date.now() / 1000);
  
  // Helper for labels
  const formatLabels = (obj) => {
    const labels = Object.entries(obj)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
    return labels ? `{${labels}}` : '';
  };
  
  // openclaw_llm_tokens_total
  for (const [key, value] of counters.tokens) {
    const [provider, model, tokenType] = key.split(':');
    const labels = formatLabels({ provider, model, token_type: tokenType });
    lines.push(`openclaw_llm_tokens_total${labels} ${value} ${now}`);
  }
  
  // openclaw_llm_cost_usd_total
  for (const [key, value] of counters.cost) {
    const [provider, model] = key.split(':');
    const labels = formatLabels({ provider, model });
    lines.push(`openclaw_llm_cost_usd_total${labels} ${value.toFixed(6)} ${now}`);
  }
  
  // openclaw_llm_duration_seconds_sum / count → _summary
  for (const [key, sum] of counters.duration.sum) {
    const [provider, model] = key.split(':');
    const count = counters.duration.count.get(key) || 1;
    const labels = formatLabels({ provider, model });
    
    // Convert ms to seconds for Prometheus convention
    lines.push(`openclaw_llm_duration_seconds_sum${labels} ${(sum / 1000).toFixed(3)} ${now}`);
    lines.push(`openclaw_llm_duration_seconds_count${labels} ${count} ${now}`);
  }
  
  // openclaw_requests_total
  lines.push(`openclaw_requests_total{type="all"} ${counters.requests.total} ${now}`);
  lines.push(`openclaw_requests_total{type="error"} ${counters.requests.errors} ${now}`);
  
  return lines.join('\n') + '\n';
}

export default function(api) {
  api.logger.info('Prometheus exporter plugin loaded');
  
  // Register /metrics HTTP endpoint
  api.registerHttpRoute({
    path: '/metrics',
    handler: async (req, res) => {
      const metrics = generateMetrics();
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(metrics);
    }
  });
  
  // Hook into llm_output to capture usage (runs in main bundle = no isolation bug)
  api.on('llm_output', (evt) => {
    const { provider, model, usage, durationMs } = evt;
    
    // Track request count
    counters.requests.total++;
    
    if (usage) {
      // Tokens by type
      if (usage.input) {
        incCounter(counters.tokens, makeKey([provider, model, 'input']), usage.input);
      }
      if (usage.output) {
        incCounter(counters.tokens, makeKey([provider, model, 'output']), usage.output);
      }
      if (usage.cacheRead) {
        incCounter(counters.tokens, makeKey([provider, model, 'cache_read']), usage.cacheRead);
      }
      if (usage.cacheWrite) {
        incCounter(counters.tokens, makeKey([provider, model, 'cache_write']), usage.cacheWrite);
      }
      if (usage.total) {
        incCounter(counters.tokens, makeKey([provider, model, 'total']), usage.total);
      }
    }
    
    // Duration (track sum and count for _summary)
    if (durationMs) {
      const key = makeKey([provider, model]);
      incCounter(counters.duration.sum, key, durationMs);
      incCounter(counters.duration.count, key, 1);
    }
    
    api.logger.debug(`Prometheus: tracked ${provider}/${model} usage`);
  });
  
  // Also track errors via llm_input hook (for error counting)
  api.on('llm_input', (evt) => {
    // llm_input fires before the call, we can track attempt
    // Note: actual error tracking would need hook into error handling
  });
  
  api.logger.info('Prometheus exporter: /metrics endpoint registered');
}
