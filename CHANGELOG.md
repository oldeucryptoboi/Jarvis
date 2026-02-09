# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-02-08

Initial release of KarnEvil9 — deterministic agent runtime.

### Added

- **Kernel** — session lifecycle orchestrator with single-shot and agentic execution modes, critic system, futility detection, context budget management, and subagent delegation
- **Schemas** — canonical type definitions (`Session`, `Task`, `Plan`, `Step`, `ToolManifest`, `JournalEvent`), JSON Schema validators (AJV), and 18 enumerated error codes
- **Journal** — append-only JSONL event log with SHA-256 hash-chain integrity, session indexing, compaction, and optional payload redaction
- **Permission engine** — `domain:action:target` permission model with multi-level caching (global/session/step), six decision types (`allow_once`, `allow_session`, `allow_always`, `allow_constrained`, `allow_observed`, `deny`), and interactive approval workflow
- **Tool system** — registry, runtime with circuit breaker pattern, and policy enforcer (path allowlisting, SSRF protection, command filtering)
- **Built-in tool handlers** — `read-file`, `write-file`, `shell-exec`, `http-request`, `browser`
- **Planner** — `MockPlanner` for testing, `LLMPlanner` with Claude/OpenAI support and prompt injection prevention, `RouterPlanner` for domain-aware task routing
- **Plugin system** — YAML manifest discovery, dynamic loading, registry with atomic reload. Plugins can register tools, hooks, routes, commands, and services
- **Hook runner** — priority-ordered plugin hooks at 9 lifecycle points (`before_session_start`, `after_session_end`, `before_plan`, `after_plan`, `before_step`, `after_step`, `before_tool_call`, `after_tool_call`, `on_error`) with circuit breaker protection
- **Memory** — `TaskStateManager` for in-session state, `WorkingMemoryManager` for ephemeral KV storage, `ActiveMemory` for cross-session lesson persistence with automatic redaction and pruning
- **REST API** — Express 5 server with session management, SSE streaming with backpressure handling, approval workflow endpoints, tool inspection, plugin management, and health checks
- **CLI** — commands for `run`, `plan`, `tools list`, `session ls/watch`, `replay`, `server`, `relay`, and `plugins list/info/reload`
- **Browser relay** — HTTP server with managed (Playwright) and extension (WebSocket bridge) drivers, supporting 11 browser action types
- **Chrome extension** — CDP bridge for browser relay extension driver

[Unreleased]: https://github.com/oldeucryptoboi/KarnEvil9/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/oldeucryptoboi/KarnEvil9/releases/tag/v0.1.0
