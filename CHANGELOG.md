# Changelog

## 1.0.0

Initial public version.

- Host-level `llm/stream` routing for DeepSeek Harness.
- Simple prompts (default `maxChars: 80`) go to a local Ollama model.
- Complex, tool-like, referenced, code, multiline, or attachment messages go to the cloud.
- Silent fallback when the local model is unreachable, times out, or returns an empty answer.
- `prewarm` option loads the local model at plugin start.
- Configurable model, endpoint, thresholds, timeout, cooldown, and source badge.
- Loopback-only local endpoint validation.
- Decision logging without message content.
