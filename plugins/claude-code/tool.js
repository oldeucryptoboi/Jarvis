/**
 * Claude Code tool — manifest and handler factory.
 *
 * Delegates coding tasks to Claude Code via the @anthropic-ai/claude-agent-sdk.
 */
import { emitAgentEvent } from "./progress.js";

/** @type {Map<string, AbortController>} Active agent invocations keyed by invocation ID */
const _activeAgents = new Map();

export const claudeCodeManifest = {
  name: "claude-code",
  version: "1.0.0",
  description: "Delegate a coding task to Claude Code (Anthropic agent SDK). Returns the agent's final output.",
  runner: "internal",
  timeout_ms: 600000,
  input_schema: {
    type: "object",
    required: ["task"],
    properties: {
      task: { type: "string", description: "The coding task to delegate" },
      cwd: { type: "string", description: "Working directory for the agent" },
      allowed_tools: {
        type: "array",
        items: { type: "string" },
        description: "Tools the agent is allowed to use (e.g. ['Bash', 'Read', 'Write'])",
      },
      system_prompt: { type: "string", description: "Optional system prompt override" },
      max_turns: { type: "integer", minimum: 1, description: "Max agentic turns" },
      _session_id: { type: "string", description: "Auto-injected by before_tool_call hook" },
      _invocation_id: { type: "string", description: "Auto-injected by before_tool_call hook" },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["completed", "failed", "aborted"] },
      result: { type: "string" },
      is_error: { type: "boolean" },
      total_cost_usd: { type: "number" },
      duration_ms: { type: "number" },
      usage: { type: "object" },
      messages_count: { type: "integer" },
    },
  },
  permissions: ["agent:execute:claude_code"],
  supports: { mock: true, dry_run: true },
};

/**
 * Create a Claude Code tool handler.
 *
 * @param {{ journal: import("@karnevil9/journal").Journal; apiKey?: string; model?: string; maxTurns?: number }} opts
 * @returns {(input: Record<string, unknown>, mode: string) => Promise<Record<string, unknown>>}
 */
export function createClaudeCodeHandler({ journal, apiKey, model, maxTurns }) {
  const resolvedApiKey = apiKey ?? process.env.ANTHROPIC_API_KEY;
  const resolvedModel = model ?? process.env.KARNEVIL9_CLAUDE_CODE_MODEL;
  const resolvedMaxTurns = maxTurns ?? (process.env.KARNEVIL9_CLAUDE_CODE_MAX_TURNS ? parseInt(process.env.KARNEVIL9_CLAUDE_CODE_MAX_TURNS, 10) : 30);

  return async (input, mode) => {
    const task = /** @type {string} */ (input.task);
    const sessionId = /** @type {string} */ (input._session_id ?? "unknown");
    const invocationId = /** @type {string} */ (input._invocation_id ?? `${sessionId}:${Date.now()}`);

    // Mock mode
    if (mode === "mock") {
      return {
        status: "completed",
        result: `[mock] Claude Code would execute: ${task}`,
        is_error: false,
        total_cost_usd: 0,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        messages_count: 0,
      };
    }

    // Dry-run mode
    if (mode === "dry_run") {
      return {
        status: "completed",
        result: `[dry_run] Would delegate to Claude Code (model: ${resolvedModel ?? "default"}): ${task}`,
        is_error: false,
        total_cost_usd: 0,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        messages_count: 0,
      };
    }

    // Real mode
    if (!resolvedApiKey) {
      return {
        status: "failed",
        result: "ANTHROPIC_API_KEY not set — cannot invoke Claude Code",
        is_error: true,
        total_cost_usd: 0,
        duration_ms: 0,
        usage: {},
        messages_count: 0,
      };
    }

    const startTime = Date.now();
    const ac = new AbortController();
    _activeAgents.set(invocationId, ac);

    // Internal timeout (slightly under tool timeout for clean shutdown)
    const internalTimeout = setTimeout(() => ac.abort(), 590000);

    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      await emitAgentEvent(journal, sessionId, "agent.started", {
        agent_type: "claude-code",
        task,
        model: resolvedModel,
        invocation_id: invocationId,
      });

      const queryOpts = {
        prompt: task,
        options: {
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          ...(resolvedModel ? { model: resolvedModel } : {}),
          ...(input.max_turns ? { maxTurns: input.max_turns } : resolvedMaxTurns ? { maxTurns: resolvedMaxTurns } : {}),
          ...(input.cwd ? { cwd: /** @type {string} */ (input.cwd) } : {}),
          ...(input.allowed_tools ? { tools: /** @type {string[]} */ (input.allowed_tools) } : {}),
          ...(input.system_prompt ? { systemPrompt: /** @type {string} */ (input.system_prompt) } : {}),
        },
      };

      let finalResult = "";
      let messagesCount = 0;
      let totalCost = 0;
      let usage = {};

      const q = query(queryOpts);

      // Wire abort signal to interrupt the query
      const onAbort = () => { q.interrupt().catch(() => {}); };
      ac.signal.addEventListener("abort", onAbort, { once: true });

      try {
        for await (const message of q) {
          messagesCount++;

          if (ac.signal.aborted) {
            break;
          }

          // Emit progress for assistant messages
          if (message.type === "assistant") {
            const content = message.message?.content;
            const preview = typeof content === "string"
              ? content.slice(0, 200)
              : Array.isArray(content)
                ? content.filter(b => b.type === "text").map(b => b.text).join(" ").slice(0, 200)
                : JSON.stringify(content ?? "").slice(0, 200);
            await emitAgentEvent(journal, sessionId, "agent.progress", {
              agent_type: "claude-code",
              invocation_id: invocationId,
              message_index: messagesCount,
              content_preview: preview,
            });
          }

          // Track tool progress
          if (message.type === "tool_progress") {
            await emitAgentEvent(journal, sessionId, "agent.tool_call", {
              agent_type: "claude-code",
              invocation_id: invocationId,
              tool_name: message.tool_name ?? "unknown",
            });
          }

          // Capture final result
          if (message.type === "result") {
            finalResult = typeof message.result === "string" ? message.result : JSON.stringify(message.result);
            if (message.cost_usd != null) totalCost = message.cost_usd;
            if (message.usage) usage = message.usage;
          }
        }
      } finally {
        ac.signal.removeEventListener("abort", onAbort);
        q.close();
      }

      if (ac.signal.aborted) {
        const duration = Date.now() - startTime;
        await emitAgentEvent(journal, sessionId, "agent.aborted", {
          agent_type: "claude-code",
          invocation_id: invocationId,
          duration_ms: duration,
        });
        return {
          status: "aborted",
          result: "Agent was aborted",
          is_error: true,
          total_cost_usd: totalCost,
          duration_ms: duration,
          usage,
          messages_count: messagesCount,
        };
      }

      const duration = Date.now() - startTime;
      await emitAgentEvent(journal, sessionId, "agent.completed", {
        agent_type: "claude-code",
        invocation_id: invocationId,
        duration_ms: duration,
        total_cost_usd: totalCost,
        messages_count: messagesCount,
      });

      return {
        status: "completed",
        result: finalResult,
        is_error: false,
        total_cost_usd: totalCost,
        duration_ms: duration,
        usage,
        messages_count: messagesCount,
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (ac.signal.aborted) {
        await emitAgentEvent(journal, sessionId, "agent.aborted", {
          agent_type: "claude-code",
          invocation_id: invocationId,
          duration_ms: duration,
        });
        return {
          status: "aborted",
          result: "Agent was aborted",
          is_error: true,
          total_cost_usd: 0,
          duration_ms: duration,
          usage: {},
          messages_count: 0,
        };
      }

      await emitAgentEvent(journal, sessionId, "agent.failed", {
        agent_type: "claude-code",
        invocation_id: invocationId,
        error: errorMessage,
        duration_ms: duration,
      });

      return {
        status: "failed",
        result: errorMessage,
        is_error: true,
        total_cost_usd: 0,
        duration_ms: duration,
        usage: {},
        messages_count: 0,
      };
    } finally {
      clearTimeout(internalTimeout);
      _activeAgents.delete(invocationId);
    }
  };
}

/**
 * Abort an active Claude Code agent invocation.
 * @param {string} invocationId
 * @returns {boolean} True if the invocation was found and aborted
 */
export function abortClaudeCode(invocationId) {
  const ac = _activeAgents.get(invocationId);
  if (ac) {
    ac.abort();
    return true;
  }
  return false;
}

/**
 * Abort all active Claude Code agents for a session.
 * @param {string} sessionId
 * @returns {number} Number of agents aborted
 */
export function abortSessionAgents(sessionId) {
  let count = 0;
  for (const [id, ac] of _activeAgents) {
    if (id.startsWith(sessionId + ":")) {
      ac.abort();
      count++;
    }
  }
  return count;
}

/**
 * Get count of active agent invocations.
 * @returns {number}
 */
export function getActiveCount() {
  return _activeAgents.size;
}
