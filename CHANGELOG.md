# Changelog

## 0.1.3 — 2026-11-07

- Restore Pi trace recording and lesson retrieval with current Sovara servers by using runner API 5, trace IDs, trace write tokens, and the current subtrace and trace I/O endpoints.
- Update child-session credential handling while preserving masking for both legacy and current token names.
- Require a server advertising runner API 5; servers supporting only API 4 are no longer compatible.
