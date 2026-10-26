# Security

## Design boundaries

`dsh-local-router` is a host-side routing plugin. It:

- only calls a loopback HTTP endpoint (`localhost`, `127.*`, `::1`);
- does not read or write files;
- does not execute shell commands;
- does not access the clipboard or credentials;
- does not modify other plugins or the host's model selection;
- logs only routing decisions, reason codes, and timings, not message text.

## Local model exposure

Simple prompts are sent to the configured local Ollama endpoint. Ollama may keep
logs or model state outside this plugin's control. If your prompts are sensitive,
review your Ollama deployment and data-retention settings.

## Prompt injection

The local model has no tools, files, browser, or shell access. A malicious prompt
can still produce misleading text; the plugin does not moderate or audit content.

## Reporting a vulnerability

Please open a private GitHub Security Advisory for this repository, or contact the
author through the repository profile. Do not include secrets or private chat
content in a public issue.
