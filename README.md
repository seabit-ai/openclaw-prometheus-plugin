# openclaw-prometheus-plugin

Prometheus metrics exporter plugin for [OpenClaw](https://openclaw.ai).

Exposes LLM usage, latency, and agent turn metrics in Prometheus text format at `GET /metrics` on the OpenClaw gateway port (default `18789`).

## Installation

### Load from local path (development)

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/openclaw-prometheus-plugin"]
    },
    "entries": {
      "openclaw-prometheus-plugin": { "enabled": true }
    }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway restart
```

### Install from npm (future)

```bash
npm install -g openclaw-prometheus-plugin
openclaw plugins install openclaw-prometheus-plugin
openclaw gateway restart
```

## Scrape Configuration

Add to `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'openclaw'
    static_configs:
      - targets: ['localhost:18789']
    metrics_path: '/metrics'
    scrape_interval: 15s
```

## Metrics Reference

### LLM Call Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `openclaw_llm_in_flight` | Gauge | `provider`, `model` | LLM API calls currently in-flight. +1 at `llm_input`, -1 at `llm_output`. Cleared on gateway restart. |
| `openclaw_llm_requests_sent_total` | Counter | `provider`, `model` | Cumulative LLM API calls sent. |
| `openclaw_llm_duration_seconds_sum` | Histogram | `provider`, `model`, `status` | Sum of per-call LLM latency (wall-time from request send to first response). `status="success"` only — failed calls have no `llm_output` event. |
| `openclaw_llm_duration_seconds_count` | Histogram | `provider`, `model`, `status` | Number of LLM call latency observations. |
| `openclaw_llm_tokens_total` | Counter | `provider`, `model`, `token_type` | Cumulative token usage. `token_type` ∈ `{input, output, cache_read, cache_write, total}`. |

### Agent Turn Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `openclaw_agent_turns_in_flight` | Gauge | `agent_id` | Agent turns currently in progress. Deduplicated by `sessionId` (OpenClaw fires `before_agent_start` twice per turn). |
| `openclaw_agent_turn_duration_seconds_sum` | Histogram | `agent_id`, `status` | Sum of agent turn wall-time (`durationMs` from `agent_end`). Includes all LLM round-trips and tool calls. `status` ∈ `{success, error}`. |
| `openclaw_agent_turn_duration_seconds_count` | Histogram | `agent_id`, `status` | Number of agent turn observations. |
| `openclaw_agent_turns_total` | Counter | `status` | Agent turns completed since last gateway start. `status` ∈ `{all, error}`. Reset on restart. |

### Notes

- **LLM latency vs agent turn duration**: `openclaw_llm_duration_seconds` measures the time from sending the LLM request to receiving the response (pure API latency). `openclaw_agent_turn_duration_seconds` measures the full turn wall-time including all tool calls and multiple LLM round-trips.
- **Error path**: If a LLM call fails (network error, timeout), `llm_output` never fires. The in-flight gauge is cleaned up best-effort at `agent_end` for the affected session.
- **No cost tracking**: Cost data is not available in the current OpenClaw plugin event schema.

## Example PromQL Queries

```promql
# Current LLM calls in-flight
openclaw_llm_in_flight

# LLM requests per minute by provider
rate(openclaw_llm_requests_sent_total[1m])

# Average LLM call latency by model (over 5 min)
rate(openclaw_llm_duration_seconds_sum[5m])
  / rate(openclaw_llm_duration_seconds_count[5m])

# Total input tokens by provider
sum by (provider) (openclaw_llm_tokens_total{token_type="input"})

# Agent turn error rate
rate(openclaw_agent_turns_total{status="error"}[5m])
  / rate(openclaw_agent_turns_total{status="all"}[5m])

# P95 agent turn duration (requires histogram_quantile; use _sum/_count as proxy)
rate(openclaw_agent_turn_duration_seconds_sum[5m])
  / rate(openclaw_agent_turn_duration_seconds_count[5m])
```

## Development

```bash
# Edit plugin
code ~/src/seabit-ai/openclaw-prometheus-plugin/index.js

# Reload: kill the gateway process (it auto-restarts via launchd)
# Note: SIGUSR1 hot-reload does NOT reload plugin files from disk
kill $(pgrep openclaw-gateway)

# Verify
curl localhost:18789/metrics
```

## License

MIT
