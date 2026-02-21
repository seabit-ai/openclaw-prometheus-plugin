# openclaw-prometheus-plugin

Prometheus metrics exporter plugin for [OpenClaw](https://openclaw.ai).

Exposes LLM usage, latency, and agent turn metrics in Prometheus text format at `GET /metrics` on the OpenClaw gateway port (default `18789`).

## Features

- **LLM metrics**: in-flight calls, requests sent, latency (sum/count), token usage
- **Agent turn metrics**: in-flight turns, duration, total/error counts
- **Persistence**: counters survive gateway restarts (saved to `$OPENCLAW_STATE_DIR/prometheus-snapshot.json`)
- **Crash safety**: auto-saves snapshot every 30 seconds
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

```
$ curl localhost:18789/metrics

openclaw_llm_in_flight{provider="anthropic",model="claude-sonnet-4-6"} 0
openclaw_llm_requests_sent_total{provider="anthropic",model="claude-sonnet-4-6"} 4
openclaw_llm_duration_seconds_sum{provider="anthropic",model="claude-sonnet-4-6",status="success"} 143.489
openclaw_llm_duration_seconds_count{provider="anthropic",model="claude-sonnet-4-6",status="success"} 3
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="input"} 118
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="output"} 6497
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="cache_read"} 1504043
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="cache_write"} 383190
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="total"} 1893848
openclaw_agent_turns_in_flight{agent_id="main"} 0
openclaw_agent_turn_duration_seconds_sum{agent_id="main",status="success"} 143.468
openclaw_agent_turn_duration_seconds_count{agent_id="main",status="success"} 3
openclaw_agent_turns_total{status="all"}   3
openclaw_agent_turns_total{status="error"} 0
```

Notes:
- `openclaw_llm_in_flight` and `openclaw_agent_turns_in_flight` are gauges — always present including when value is 0
- `openclaw_llm_duration_seconds` = pure LLM API latency (llm_input → llm_output)
- `openclaw_agent_turn_duration_seconds` = full turn wall-time including all tool calls and LLM round-trips
- Cost data is not available in the OpenClaw plugin event schema

### Event log

Append `?lines=N` to return the last N entries from the rolling event log (max 1000):

```
$ curl 'localhost:18789/metrics?lines=10'
...
# 2026-02-21T19:01:47.008Z gateway_start - restored snapshot (age 2.6s)
# 2026-02-21T19:02:41.439Z before_agent_start agentId=main sessionId=b2fd966f-...
# 2026-02-21T19:02:41.488Z llm_input  runId=246871ef-... sessionId=b2fd966f-... anthropic/claude-sonnet-4-6
# 2026-02-21T19:03:05.381Z llm_output runId=246871ef-... sessionId=b2fd966f-... anthropic/claude-sonnet-4-6
# 2026-02-21T19:03:05.390Z agent_end  agentId=main sessionId=b2fd966f-... success 23892ms
# 2026-02-21T19:03:35.000Z auto-save - saved snapshot (1 models, 1 turns)
```

## Persistence

Cumulative counters (`*_total`, `*_sum`, `*_count`, token counts) are automatically persisted to disk:

- **On shutdown**: saved synchronously via `gateway_stop` hook
- **Every 30 seconds**: auto-saved as crash safety
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
```

## Development

```bash
# Edit plugin
code ~/src/seabit-ai/openclaw-prometheus-plugin/index.js

# Reload (plugins are loaded fresh on each restart)
openclaw gateway restart

# Verify
curl localhost:18789/metrics
curl 'localhost:18789/metrics?lines=20'
```

## License

MIT
