# openclaw-prometheus-plugin

Prometheus metrics exporter plugin for OpenClaw.

Exposes OpenClaw LLM usage metrics in Prometheus text format at `http://localhost:18789/metrics`.

## Why This Plugin?

The built-in `diagnostics-otel` plugin has a known event bus isolation bug that prevents it from receiving `model.usage` events. This plugin uses the `llm_output` hook which runs in the main bundle, completely bypassing that bug.

## Features

- **Token usage** by provider, model, and token type (input/output/cache)
- **Cost tracking** in USD (if provided by the LLM provider)
- **Duration metrics** as Prometheus summaries
- **Request counts** (total + errors)
- Standard Prometheus `/metrics` endpoint with text format

## Installation

### Option 1: Link local development
```bash
openclaw plugins install --link ~/src/seabit-ai/openclaw-prometheus-plugin
```

### Option 2: npm (future)
```bash
npm install -g openclaw-prometheus-plugin
openclaw plugins install openclaw-prometheus-plugin
```

Then restart the gateway:
```bash
openclaw gateway restart
```

## Usage

### Configure Prometheus to scrape

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'openclaw'
    static_configs:
      - targets: ['localhost:18789']
    metrics_path: '/metrics'
```

### Query in Prometheus

```promql
# Total tokens by provider
sum by (provider) (openclaw_llm_tokens_total)

# Tokens by model
openclaw_llm_tokens_total{model="claude-sonnet-4-6"}

# Cost by provider
sum by (provider) (openclaw_llm_cost_usd_total)

# Average latency
rate(openclaw_llm_duration_seconds_sum[5m]) / rate(openclaw_llm_duration_seconds_count[5m])
```

### Example Grafana Dashboard

Import the JSON from `grafana-dashboard.json` for pre-built panels.

## Metrics Reference

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `openclaw_llm_tokens_total` | Counter | `provider`, `model`, `token_type` | Total tokens used |
| `openclaw_llm_cost_usd_total` | Counter | `provider`, `model` | Estimated cost in USD |
| `openclaw_llm_duration_seconds_sum` | Summary | `provider`, `model` | Total duration (seconds) |
| `openclaw_llm_duration_seconds_count` | Summary | `provider`, `model` | Request count |
| `openclaw_requests_total` | Counter | `type` | Total requests (type: all/error) |

## Development

```bash
# Edit the plugin
code ~/src/seabit-ai/openclaw-prometheus-plugin

# Restart gateway to reload
openclaw gateway restart
```

## License

MIT
