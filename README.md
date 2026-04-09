# OCCA OpenCode Provider Plugin

Automatically reads `occa.json` and registers multiple providers (OpenAI / Claude / Gemini) into OpenCode with model lists fetched from the API.

## Features

- **Auto-detect config** — scans current directory, then fallback to `~/.config/opencode/occa.json`
- **Multi-provider** — one config file, unlimited providers
- **Auto model fetch** — pulls model lists from each API on startup
- **Config validation** — clear error messages for misconfiguration
- **Hot reload** — watches config file, auto-reloads on changes
- **Model filtering** — include/exclude models per provider with glob patterns
- **Token masking** — API keys masked in logs (`sk-***abc`)
- **Model caching** — caches model lists with configurable TTL
- **Custom headers** — add extra headers per provider
- **Per-provider timeout** — configurable request timeout

## Installation

```bash
npm install -g occa-opencode-provider
```

Add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["occa-opencode-provider"]
}
```

## Configuration

The plugin looks for `occa.json` in this order:

1. **Environment variable**: `OCCA_CONFIG_PATH` (full path to config file)
2. **Current directory**: `./occa.json` (where you run `opencode`)
3. **Default location**: `~/.config/opencode/occa.json`

Example: Run `opencode` in `/workspace/` with `/workspace/occa.json` — plugin auto-detects it.

### Minimal

```json
{
  "provider": {
    "openai": {
      "baseurl": "https://api.openai.com/v1",
      "key": "sk-xxx",
      "type": "openai"
    }
  }
}
```

### Full

```json
{
  "settings": {
    "cache_ttl": 1800,
    "hot_reload": true
  },
  "provider": {
    "openai": {
      "baseurl": "https://api.openai.com/v1",
      "key": "sk-xxx",
      "type": "openai",
      "timeout": 15000,
      "headers": {
        "X-Custom-Header": "value"
      },
      "models": {
        "include": ["gpt-4*", "o3*"],
        "exclude": ["*vision*", "*audio*"]
      }
    },
    "claude": {
      "baseurl": "https://api.anthropic.com",
      "key": "sk-ant-xxx",
      "type": "claude"
    },
    "gemini": {
      "baseurl": "https://generativelanguage.googleapis.com/v1beta",
      "key": "AIza-xxx",
      "type": "gemini"
    },
    "openrouter": {
      "baseurl": "https://openrouter.ai/api/v1",
      "key": "sk-or-xxx",
      "type": "openai",
      "models": {
        "include": ["anthropic/*", "google/*", "openai/*"]
      }
    },
    "custom-api": {
      "baseurl": "https://api.example.com/v1",
      "key": "your-api-key",
      "type": "openai",
      "headers": {
        "auth_header": {
          "key": "X-API-Key",
          "value": "your-api-key"
        }
      }
    }
  }
}
```

## Config Reference

### `settings`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cache_ttl` | number | `1800` | Model cache TTL in seconds (0 to disable) |
| `hot_reload` | boolean | `true` | Watch config file for changes and auto-reload |

### `provider.<name>`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `baseurl` | string | Yes | API base URL |
| `key` | string | Yes | API key / token |
| `type` | string | No | API type: `openai` \| `claude` \| `gemini` (default: `openai`) |
| `timeout` | number | No | Request timeout in ms (default: `15000`) |
| `headers` | object | No | Custom headers to include in API requests |
| `headers.auth_header` | object | No | Custom authentication header format (e.g. `{key: "X-API-Key", value: "your-key"}`) |
| `models.include` | string[] | No | Glob patterns — only include matching models |
| `models.exclude` | string[] | No | Glob patterns — exclude matching models |

## Supported API Types

| Type | SDK | Models Endpoint | Providers |
|------|-----|-----------------|-----------|
| `openai` | `@ai-sdk/openai-compatible` | `GET {baseurl}/models` | OpenAI, DeepSeek, Groq, OpenRouter, Together, Fireworks, Ollama, xAI, etc. |
| `claude` | `@ai-sdk/anthropic` | `GET {baseurl}/v1/models` | Anthropic Claude |
| `gemini` | `@ai-sdk/google` | `GET {baseurl}/models?key={key}` | Google Gemini |

## Example Providers

<details>
<summary>OpenAI</summary>

```json
{
  "baseurl": "https://api.openai.com/v1",
  "key": "sk-proj-xxx",
  "type": "openai"
}
```
</details>

<details>
<summary>Claude (Anthropic)</summary>

```json
{
  "baseurl": "https://api.anthropic.com",
  "key": "sk-ant-api03-xxx",
  "type": "claude"
}
```
</details>

<details>
<summary>Gemini (Google)</summary>

```json
{
  "baseurl": "https://generativelanguage.googleapis.com/v1beta",
  "key": "AIzaSy-xxx",
  "type": "gemini"
}
```
</details>

<details>
<summary>OpenRouter</summary>

```json
{
  "baseurl": "https://openrouter.ai/api/v1",
  "key": "sk-or-v1-xxx",
  "type": "openai",
  "models": {
    "include": ["anthropic/*", "google/*", "openai/*", "meta-llama/*"]
  }
}
```
</details>

<details>
<summary>DeepSeek</summary>

```json
{
  "baseurl": "https://api.deepseek.com/v1",
  "key": "sk-xxx",
  "type": "openai"
}
```
</details>

<details>
<summary>Groq</summary>

```json
{
  "baseurl": "https://api.groq.com/openai/v1",
  "key": "gsk_xxx",
  "type": "openai"
}
```
</details>

<details>
<summary>Ollama (local)</summary>

```json
{
  "baseurl": "http://localhost:11434/v1",
  "key": "ollama",
  "type": "openai"
}
```
</details>

## Logging & Debugging

Logs are written to `~/.cache/opencode/occa-plugin/`:

| File | Content |
|------|---------|
| `debug.log` | All activity (startup, config, model fetches, cache hits) |
| `error.log` | Errors only (failed fetches, parse errors, validation) |
| `models-cache.json` | Cached model lists |

```bash
# Watch all logs
tail -f ~/.cache/opencode/occa-plugin/debug.log

# Watch errors only
tail -f ~/.cache/opencode/occa-plugin/error.log
```

## License

MIT
