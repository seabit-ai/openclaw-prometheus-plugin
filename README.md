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

```
$ curl localhost:18789/metrics

openclaw_llm_in_flight{provider="anthropic",model="claude-sonnet-4-6"} 1
openclaw_llm_requests_sent_total{provider="anthropic",model="claude-sonnet-4-6"} 4
openclaw_llm_duration_seconds_sum{provider="anthropic",model="claude-sonnet-4-6",status="success"} 143.489
openclaw_llm_duration_seconds_count{provider="anthropic",model="claude-sonnet-4-6",status="success"} 3
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="input"} 118
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="output"} 6497
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="cache_read"} 1504043
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="cache_write"} 383190
openclaw_llm_tokens_total{provider="anthropic",model="claude-sonnet-4-6",token_type="total"} 1893848
openclaw_agent_turns_in_flight{agent_id="main"} 1
openclaw_agent_turn_duration_seconds_sum{agent_id="main",status="success"} 143.468
openclaw_agent_turn_duration_seconds_count{agent_id="main",status="success"} 3
openclaw_agent_turns_total{status="all"}   3
openclaw_agent_turns_total{status="error"} 0
```

Notes:
- `openclaw_llm_duration_seconds` = pure LLM API latency (llm_input → llm_output)
- `openclaw_agent_turn_duration_seconds` = full turn wall-time including all tool calls and LLM round-trips
- Cost data is not available in the OpenClaw plugin event schema

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
