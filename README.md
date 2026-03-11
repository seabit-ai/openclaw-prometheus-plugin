# openclaw-prometheus-plugin

Prometheus metrics exporter plugin for [OpenClaw](https://openclaw.ai).

Exposes LLM usage, latency, cost, and agent turn metrics in Prometheus text format at `GET /metrics` on the OpenClaw gateway port (default `18789`).

## Features

- **LLM metrics**: in-flight calls, requests sent, latency (sum/count), token usage
- **Cost estimation**: per-model USD cost tracking with hot-reloadable pricing file + OpenRouter API fallback
- **Agent turn metrics**: in-flight turns, duration, total/error counts
- **Persistence**: counters survive gateway restarts (saved to `$OPENCLAW_STATE_DIR/prometheus-snapshot.json`)
- **Crash safety**: auto-saves snapshot every 30 seconds (only when data changed)
- **Event log**: rolling 1000-entry debug log queryable via `?lines=N`

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

### Install from npm

```bash
openclaw plugins install @seabit-ai/openclaw-prometheus-plugin
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

> **Docker users**: If Prometheus runs in Docker and OpenClaw runs on the host, use `host.docker.internal:18789` instead of `localhost:18789`.

## Metrics Reference

```
$ curl localhost:18789/metrics

# LLM call gauges (always present, even when 0)
openclaw_llm_in_flight{provider="anthropic",model="claude-sonnet-4-6"} 0

# LLM request counters
openclaw_llm_requests_sent_total{provider="anthropic",model="claude-sonnet-4-6"} 4

# LLM call latency (pure API time, excludes tool calls)
openclaw_llm_duration_seconds_sum{provider="anthropic",model="claude-sonnet-4-6",status="success"} 143.489
openclaw_llm_duration_seconds_count{provider="anthropic",model="claude-sonnet-4-6",status="success"} 3

# Token counters (cumulative, persisted across restarts)
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="input"} 118
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="output"} 6497
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="cache_read"} 1504043
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="cache_write"} 383190
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="total"} 1893848

# Estimated cost in USD (cumulative, persisted across restarts)
openclaw_estimated_cost_dollars_total{provider="anthropic",model="claude-sonnet-4-6",token_type="input"} 0.000354
openclaw_estimated_cost_dollars_total{provider="anthropic",model="claude-sonnet-4-6",token_type="output"} 0.097455
openclaw_estimated_cost_dollars_total{provider="anthropic",model="claude-sonnet-4-6",token_type="cache_read"} 0.451213
openclaw_estimated_cost_dollars_total{provider="anthropic",model="claude-sonnet-4-6",token_type="cache_write"} 1.436963
openclaw_estimated_cost_dollars_total{provider="anthropic",model="claude-sonnet-4-6",token_type="total"} 1.985985

# Agent turn metrics
openclaw_agent_turns_in_flight{agent_id="main"} 0
openclaw_agent_turn_duration_seconds_sum{agent_id="main",status="success"} 143.468
openclaw_agent_turn_duration_seconds_count{agent_id="main",status="success"} 3
openclaw_agent_turns_total{status="all"}   3
openclaw_agent_turns_total{status="error"} 0
```

**Notes:**
- `openclaw_llm_in_flight` and `openclaw_agent_turns_in_flight` are gauges — always present including when value is 0
- `openclaw_llm_duration_seconds` = pure LLM API latency (`llm_input` → `llm_output`)
- `openclaw_agent_turn_duration_seconds` = full turn wall-time including all tool calls and LLM round-trips
- `openclaw_estimated_cost_dollars_total` = `0` for models with unknown pricing (see [Cost Estimation](#cost-estimation))

### Event log

Append `?lines=N` to return the last N entries from the rolling event log (max 1000):

```
$ curl 'localhost:18789/metrics?lines=10'
...
# 2026-02-22T23:47:31.929Z gateway_start - restored snapshot (age 2.0s)
# 2026-02-22T23:47:32.124Z pricing - loaded 337 models from OpenRouter
# 2026-02-22T23:48:10.001Z before_agent_start agentId=main sessionId=b2fd966f-...
# 2026-02-22T23:48:10.052Z llm_input  runId=246871ef-... sessionId=b2fd966f-... anthropic/claude-sonnet-4-6
# 2026-02-22T23:48:33.381Z llm_output runId=246871ef-... sessionId=b2fd966f-... anthropic/claude-sonnet-4-6
# 2026-02-22T23:48:33.390Z agent_end  agentId=main sessionId=b2fd966f-... success 23892ms
# 2026-02-22T23:49:03.000Z auto-save - saved snapshot (1 models, 1 turns)
```

## Cost Estimation

The plugin tracks `openclaw_estimated_cost_dollars_total` using a two-layer pricing lookup:

### Layer 1: Local pricing file (hot-reloadable, highest priority)

Copy `llm-pricing.example.json` to `~/.openclaw/llm-pricing.json` and edit as needed:

```json
{
  "anthropic:claude-sonnet-4-6": {
    "input":       3.00,
    "output":      15.00,
    "cache_write":  3.75,
    "cache_read":   0.30
  }
}
```

Keys use `provider:model` format matching OpenClaw's identifiers. Prices are in **USD per 1M tokens (MTok)**.

Changes to this file are picked up **automatically** — no gateway restart needed.

### Layer 2: OpenRouter API (automatic fallback)

On startup, the plugin fetches pricing for ~300+ models from `https://openrouter.ai/api/v1/models` and caches them in memory. This covers most major providers automatically.

If a model appears in neither layer, its cost is not tracked (a warning is logged to the event log).

## Persistence

Cumulative counters (`*_total`, `*_sum`, `*_count`, token counts, cost) are automatically persisted to disk:

- **On shutdown**: saved synchronously via `gateway_stop` hook
- **Every 30 seconds**: auto-saved (only when data has changed since last save)
- **On startup**: restored from snapshot so counters never reset on restart

Snapshot path: `$OPENCLAW_STATE_DIR/prometheus-snapshot.json` (default: `~/.openclaw/prometheus-snapshot.json`)

Transient gauges (`in_flight`) are **not** persisted — they reset to 0 on restart and are initialized for all known provider/model combinations from the snapshot.

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

# Average agent turn duration
rate(openclaw_agent_turn_duration_seconds_sum[5m])
  / rate(openclaw_agent_turn_duration_seconds_count[5m])

# --- Cost queries ---

# Total cumulative cost by model (all token types combined)
sum by (provider, model) (openclaw_estimated_cost_dollars_total{token_type="total"})

# Cost breakdown by token type (to see cache vs. compute split)
sum by (token_type) (openclaw_estimated_cost_dollars_total)

# Estimated hourly burn rate ($/hr, rolling average)
sum(rate(openclaw_estimated_cost_dollars_total{token_type="total"}[1h])) * 3600

# Cost per hour (bar chart — set Min interval = 1h in Grafana)
sum(increase(openclaw_estimated_cost_dollars_total{token_type="total"}[$__interval]))
```

## Grafana Dashboard

A pre-built Grafana dashboard is included at [`grafana/openclaw-llm-metrics.json`](grafana/openclaw-llm-metrics.json).

### Import steps

1. Open Grafana → **Dashboards → Import**
2. Upload `grafana/openclaw-llm-metrics.json`
3. Select your Prometheus datasource
4. Click **Import**

The dashboard includes panels for:
- LLM in-flight calls & request rate (QPM)
- LLM latency (average)
- Token usage by type
- Agent turn duration & error rate
- Estimated cost rate ($/min by model)
- Cost per token type breakdown
- **Cost per hour** (bar chart, aligned to whole hours)

## Development

```bash
# Clone and load
git clone https://github.com/seabit-ai/openclaw-prometheus-plugin
# Add to openclaw.json plugins.load.paths (see Installation above)

# Edit
code ~/src/seabit-ai/openclaw-prometheus-plugin/index.js

# Reload (plugins are loaded fresh on each restart)
openclaw gateway restart

# Verify
curl localhost:18789/metrics
curl 'localhost:18789/metrics?lines=20'

# Check cost tracking
curl 'localhost:18789/metrics?lines=5' | grep -E "pricing|cost"
```

## License

MIT
