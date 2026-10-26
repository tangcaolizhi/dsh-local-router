# Contributing

Thanks for considering a contribution.

## Development

Requirements:

- Node.js `>=22.15`
- Optional: a local Ollama instance with `qwen2:1.5b` for integration tests

```bash
node --check index.js
node --test test/pure.test.mjs
```

Integration tests (real local model) require Ollama:

```bash
ollama pull qwen2:1.5b
ollama serve
node --test test/router.test.mjs
```

## Pull requests

- Keep routing changes small and measurable.
- Add a pure test for any new classification rule.
- Do not add a dependency unless it is strictly necessary; this plugin is intentionally dependency-free.
- Never commit API keys, tokens, `.env` files, private prompts, or group/member data.
- Update `README.md` when behavior or configuration changes.

## Reporting issues

Please include:

- DSH version, OS, Node version;
- Ollama version and model name;
- the routing decision from logs (`decision=... reason=...`, without message content);
- whether the message had attachments / tools / group context.

Do not paste full private conversations. A redacted excerpt is enough.
