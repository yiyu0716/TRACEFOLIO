# TRACEFOLIO development guidance

## Web Research

Use Exa MCP proactively when external or up-to-date information would materially improve the task.
Prefer Exa for technical research, papers and arXiv, GitHub repositories and code examples,
documentation, similar implementations, and semantic or ambiguous searches.
Use `web_search_exa` for discovery and `web_fetch_exa` when full source contents are needed.
For important technical claims, prefer primary sources and cross-check independent sources.
Do not rely on model memory for information that may have changed. If Exa is unavailable,
disclose that and use available search and primary sources.

## Project scope

- Read README.md, docs/ARCHITECTURE.md and docs/UPSTREAM.md before changing architecture.
- This release is a local, single-user prototype. Do not describe it as a production SaaS.
- Preserve upstream Apache-2.0 notices and identify modifications to imported source files.
- Keep career facts separate from model suggestions; self reports are not independently verified evidence.
- Respect confirmation, expiry, consent and revision checks. Never silently turn conversation into permanent facts.
- Existing and new business tables all require tenant ownership before any public multi-user release.
- Never commit credentials, .env, databases or personal career materials. GitHub credentials are not model keys.
- Use Node.js 22+. Run appropriate tests, npm run lint, npm run typecheck and npm run build for application changes.
- Critical behavior belongs in tests: consent/expiry, citation validity, optimistic writes and derived-record invalidation.
- Test model adapters with fake runtimes unless the user supplies and authorizes live service usage.
