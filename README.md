# Jarvis

Deterministic agent runtime with explicit plans, typed tools, permissions, and replay.

Jarvis converts a natural-language task into a structured execution plan, runs each step under fine-grained permission control, and records every event in a tamper-evident journal. It supports single-shot execution and an agentic feedback loop with iterative re-planning, futility detection, and context budget management.

## Quick Start

```bash
# Prerequisites: Node.js ≥ 20, pnpm ≥ 9.15
pnpm install
pnpm build

# Run a task (mock mode — no API keys required)
npx jarvis run "read the contents of package.json"

# Run with an LLM planner
export ANTHROPIC_API_KEY=sk-...
npx jarvis run "list all TypeScript files in src/" --planner claude --mode real

# Agentic mode (iterative planning)
npx jarvis run "refactor utils into separate modules" --planner claude --mode real --agentic
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `jarvis run <task>` | Execute a task end-to-end |
| `jarvis plan <task>` | Generate a plan without executing |
| `jarvis tools list` | List registered tools |
| `jarvis session ls` | List sessions from journal |
| `jarvis session watch <id>` | Watch session events in real-time |
| `jarvis replay <id>` | Replay session events with integrity check |
| `jarvis server` | Start the REST API server |
| `jarvis relay` | Start the browser automation relay |
| `jarvis plugins list\|info\|reload` | Plugin management |

### Key Options

```
--mode <mode>         Execution mode: mock, dry_run, real (default: mock)
--planner <type>      Planner backend: mock, claude, openai, router
--model <name>        LLM model name
--agentic             Enable iterative plan-execute-replan loop
--context-budget      Proactive context budget management (requires --agentic)
--max-steps <n>       Maximum steps (default: 20)
--plugins-dir <dir>   Plugin directory (default: plugins)
--no-memory           Disable cross-session learning
```

## API Server

```bash
npx jarvis server --port 3100 --planner claude --agentic
```

| Endpoint | Description |
|----------|-------------|
| `POST /sessions` | Create and run a session |
| `GET /sessions/:id` | Get session status |
| `GET /sessions/:id/stream` | SSE event stream |
| `POST /sessions/:id/abort` | Abort a running session |
| `GET /approvals` | List pending permission requests |
| `POST /approvals/:id` | Submit approval decision |
| `GET /tools` | List available tools |
| `GET /health` | System health check |

## Architecture

Jarvis is a pnpm monorepo with 11 packages under `packages/`, all scoped as `@jarvis/*`:

```
schemas                     ← Foundation: types, validators, error codes
  ↓
journal, permissions, memory  ← Core infrastructure
  ↓
tools                       ← Registry, runtime, policy enforcement, handlers
  ↓
planner, plugins            ← LLM adapters & extensibility
  ↓
kernel                      ← Orchestrator: session lifecycle, execution phases
  ↓
api, cli, browser-relay     ← Entry points
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture reference.

### Execution Flow

**Single-shot:** Plan once, execute all steps, done.

**Agentic:** Loop of plan → execute → observe results → replan, until the planner signals completion or a halt condition triggers (futility detection, budget exceeded, max iterations).

Each step passes through: input validation → permission check → tool execution → output validation → result recording.

## Built-in Tools

| Tool | Description |
|------|-------------|
| `read-file` | Read files with symlink-safe path validation |
| `write-file` | Write files with approval flow and atomic writes |
| `shell-exec` | Execute shell commands with env sanitization and command filtering |
| `http-request` | HTTP requests with SSRF protection |
| `browser` | Browser automation via relay (Playwright or extension) |

## Permission System

Permissions use a `domain:action:target` format (e.g., `filesystem:write:workspace`). The engine supports six decision types:

- **allow_once** — single step
- **allow_session** — lifetime of session
- **allow_always** — persists across sessions
- **allow_constrained** — with path/endpoint restrictions
- **allow_observed** — with telemetry logging
- **deny** — with optional alternative tool suggestion

## Plugin System

Plugins are directories containing a `plugin.yaml` manifest and a JS entry module:

```yaml
id: my-plugin
name: My Plugin
version: 1.0.0
description: What it does
entry: index.js
permissions: []
provides:
  hooks: [before_step, after_step]
  tools: []
```

The entry module exports a `register(api)` function that can call `registerTool()`, `registerHook()`, `registerRoute()`, `registerCommand()`, and `registerService()`. See `plugins/example-logger/` for a working example.

## Security

- **Permission gates** on every tool invocation with multi-level caching
- **Policy enforcement** — path allowlisting, SSRF protection (private IP blocking, port whitelist), command filtering
- **Prompt injection prevention** — untrusted data wrapped in structured delimiters
- **Journal integrity** — SHA-256 hash chain for tamper detection
- **Credential sanitization** — env vars filtered from shell, payloads redacted in journal
- **Circuit breakers** — per-tool failure tracking prevents cascading failures

## Development

```bash
pnpm build        # Build all packages
pnpm dev          # Watch mode (parallel)
pnpm test         # Run all unit tests
pnpm test:e2e     # Run e2e smoke tests
pnpm lint         # Lint all packages
pnpm clean        # Remove dist directories

# Single package
pnpm --filter @jarvis/kernel test
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | For Claude planner | Anthropic API key |
| `OPENAI_API_KEY` | For OpenAI planner | OpenAI API key |

Create a `.env` file in the project root (gitignored).

## License

Private
