# Hello World with Claude Code Plugin

KarnEvil9 can delegate coding tasks to external AI agents via its plugin system. The **Claude Code plugin** wraps Anthropic's agent SDK, letting the planner generate steps that spawn a fully autonomous Claude Code session — complete with file system access, tool use, and journal event streaming.

This walkthrough covers a minimal end-to-end test: asking KarnEvil9 to create a TypeScript file that prints "Hello World".

---

## Prerequisites

1. **Node.js 20+** and **pnpm 9.15+** installed
2. A built KarnEvil9 monorepo (`pnpm install && pnpm build`)
3. An Anthropic API key exported as `ANTHROPIC_API_KEY`

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Verify the Plugin Loads

```bash
karnevil9 plugins list
```

Expected output (among other plugins):

```
claude-code v1.0.0 [active]
  Delegates coding tasks to Claude Code via the Anthropic agent SDK
  Provides: tools: claude-code; hooks: before_plan, before_tool_call, after_session_end;
            routes: status; services: claude-code-agent
```

If `ANTHROPIC_API_KEY` is not set, the plugin still loads but registers stubs (graceful degradation). The status route will report `{ "available": false }`.

## Run the Hello World Task

```bash
karnevil9 run "use the claude-code tool to create hello.ts that prints hello world" \
  --planner claude --mode real --agentic
```

### What Happens

1. **Planning** — The Claude planner receives tool schemas including `claude-code`. The `before_plan` hook injects `claude_code_context` into the planner snapshot, informing it that Claude Code is available.

2. **Permission gate** — KarnEvil9 prompts for the `agent:execute:claude_code` permission. Choose `[a]llow once` to proceed.

3. **Agent execution** — The `claude-code` tool handler:
   - Spawns a Claude Code session via `query()` from `@anthropic-ai/claude-agent-sdk`
   - Runs with `permissionMode: "bypassPermissions"` (KarnEvil9 handles permissions at its own layer)
   - Streams progress as journal events (`agent.started`, `agent.progress`, `agent.completed`)

4. **Result** — Claude Code creates `hello.ts` and returns a structured result to the kernel.

5. **Agentic re-plan** — The planner sees the task is complete and emits an empty plan, ending the session.

### Sample Output

```
KarnEvil9 session starting...
Task: use the claude-code tool to create hello.ts that prints hello world
Mode: real
Tools: browser, http-request, read-file, shell-exec, write-file, claude-code, ...

[16:55:13] session.created
[16:55:13] session.started
[16:55:13] planner.requested
[16:55:13] agent.started
  Agent claude-code started
[16:55:20] agent.progress
[16:55:28] agent.progress
[16:55:29] agent.completed
  Agent claude-code completed (15596ms)

--- Output (step-1) ---
{
  "status": "completed",
  "result": "I've created the hello.ts file that prints 'Hello, World!'...",
  "is_error": false,
  "duration_ms": 15596,
  "messages_count": 6
}
--- End ---

[16:55:37] session.completed

Session 9b88dd13-...
Status: completed
Steps completed: 1/1
Tokens: 10,442 (10,004 in / 438 out)
```

### Verify the Result

```bash
npx tsx hello.ts
```

```
Hello World
```

## How the Plugin Works

### Architecture

```
KarnEvil9 Kernel
  │
  ├─ Planner (Claude) ─── sees claude_code_context via before_plan hook
  │
  ├─ Step: claude-code tool
  │    │
  │    ├─ before_tool_call hook → injects _session_id, _invocation_id
  │    ├─ Permission gate → agent:execute:claude_code
  │    ├─ Tool handler → spawns Claude Code via @anthropic-ai/claude-agent-sdk
  │    │    ├─ agent.started  → journal
  │    │    ├─ agent.progress → journal (throttled, max 1/2s)
  │    │    └─ agent.completed → journal
  │    └─ Result → structured output back to kernel
  │
  └─ Agentic re-plan → empty plan → session.completed
```

### Plugin Files

| File | Purpose |
|------|---------|
| `plugins/claude-code/plugin.yaml` | Manifest declaring tools, hooks, routes, services |
| `plugins/claude-code/index.js` | Registration entry point with graceful degradation |
| `plugins/claude-code/tool.js` | Tool manifest, handler factory, abort management |
| `plugins/claude-code/progress.js` | Throttled journal event emitter |

### Journal Events

The plugin emits six event types:

| Event | When |
|-------|------|
| `agent.started` | Agent session begins |
| `agent.progress` | Intermediate output (throttled to 1 per 2s) |
| `agent.tool_call` | Agent uses an internal tool |
| `agent.completed` | Agent finishes successfully |
| `agent.failed` | Agent encounters an error |
| `agent.aborted` | Agent is cancelled (session abort or timeout) |

### Configuration

| Env Var | Description |
|---------|-------------|
| `ANTHROPIC_API_KEY` | Required. Anthropic API key. |
| `KARNEVIL9_CLAUDE_CODE_MODEL` | Optional. Model override (e.g. `claude-sonnet-4-5-20250929`). |
| `KARNEVIL9_CLAUDE_CODE_MAX_TURNS` | Optional. Max agentic turns per invocation (default: 30). |

### Graceful Degradation

Without `ANTHROPIC_API_KEY`, the plugin registers stubs:
- The `claude-code` tool returns an error in real mode, a mock response in mock mode
- The status route reports `{ "available": false }`
- No hooks or services are active

This means KarnEvil9 always boots cleanly regardless of which API keys are configured.

## API Server Mode

The plugin also works via the REST API:

```bash
karnevil9 server --planner claude --agentic --insecure

# Check plugin status
curl http://localhost:3100/api/plugins/claude-code/status
# → { "available": true, "model": "default", "active_agents": 0 }
```

Submit tasks via the `/api/sessions` endpoint or WebSocket — the planner will use `claude-code` when appropriate.
