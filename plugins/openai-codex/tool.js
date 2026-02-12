/**
 * OpenAI Codex tool — manifest and handler factory.
 *
 * Delegates coding tasks to OpenAI Codex via the @openai/codex-sdk.
 */
import { emitAgentEvent } from "./progress.js";

/** @type {Map<string, AbortController>} Active agent invocations keyed by invocation ID */
const _activeAgents = new Map();

/** @type {unknown} Lazily-created singleton Codex instance */
let _codexInstance = null;

export const openaiCodexManifest = {
  name: "openai-codex",
  version: "1.0.0",
  description: "Delegate a coding task to OpenAI Codex. Returns the agent's final output.",
  runner: "internal",
  timeout_ms: 600000,
  input_schema: {
    type: "object",
    required: ["task"],
    properties: {
      task: { type: "string", description: "The coding task to delegate" },
      cwd: { type: "string", description: "Working directory for the agent" },
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
      duration_ms: { type: "number" },
      usage: { type: "object" },
      items_count: { type: "integer" },
    },
  },
  permissions: ["agent:execute:openai_codex"],
  supports: { mock: true, dry_run: true },
};

/**
 * Create an OpenAI Codex tool handler.
 *
 * @param {{ journal: import("@karnevil9/journal").Journal; apiKey?: string; model?: string }} opts
 * @returns {(input: Record<string, unknown>, mode: string) => Promise<Record<string, unknown>>}
 */
export function createOpenaiCodexHandler({ journal, apiKey, model }) {
  const resolvedApiKey = apiKey ?? process.env.OPENAI_API_KEY;
  const resolvedModel = model ?? process.env.KARNEVIL9_CODEX_MODEL;

  return async (input, mode) => {
    const task = /** @type {string} */ (input.task);
    const sessionId = /** @type {string} */ (input._session_id ?? "unknown");
    const invocationId = /** @type {string} */ (input._invocation_id ?? `${sessionId}:${Date.now()}`);

    // Mock mode
    if (mode === "mock") {
      return {
        status: "completed",
        result: `[mock] OpenAI Codex would execute: ${task}`,
        is_error: false,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        items_count: 0,
      };
    }

    // Dry-run mode
    if (mode === "dry_run") {
      return {
        status: "completed",
        result: `[dry_run] Would delegate to OpenAI Codex (model: ${resolvedModel ?? "default"}): ${task}`,
        is_error: false,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        items_count: 0,
      };
    }

    // Real mode
    if (!resolvedApiKey) {
      return {
        status: "failed",
        result: "OPENAI_API_KEY not set — cannot invoke OpenAI Codex",
        is_error: true,
        duration_ms: 0,
        usage: {},
        items_count: 0,
      };
    }

    const startTime = Date.now();
    const ac = new AbortController();
    _activeAgents.set(invocationId, ac);

    // Internal timeout (slightly under tool timeout for clean shutdown)
    const internalTimeout = setTimeout(() => ac.abort(), 590000);

    try {
      const { Codex } = await import("@openai/codex-sdk");

      // Lazily create singleton Codex instance (reused across invocations)
      if (!_codexInstance) {
        _codexInstance = new Codex({
          apiKey: resolvedApiKey,
          ...(resolvedModel ? { model: resolvedModel } : {}),
        });
      }

      await emitAgentEvent(journal, sessionId, "agent.started", {
        agent_type: "openai-codex",
        task,
        model: resolvedModel,
        invocation_id: invocationId,
      });

      const workingDirectory = /** @type {string} */ (input.cwd ?? process.cwd());
      const thread = _codexInstance.startThread({ workingDirectory });
      const stream = thread.runStreamed(task, { signal: ac.signal });

      let finalResult = "";
      let itemsCount = 0;
      let usage = {};

      for await (const event of stream) {
        itemsCount++;

        if (ac.signal.aborted) {
          break;
        }

        // Emit progress for intermediate events
        if (event.type === "message" || event.type === "text") {
          await emitAgentEvent(journal, sessionId, "agent.progress", {
            agent_type: "openai-codex",
            invocation_id: invocationId,
            item_index: itemsCount,
            content_preview: typeof event.content === "string"
              ? event.content.slice(0, 200)
              : typeof event.text === "string"
                ? event.text.slice(0, 200)
                : JSON.stringify(event).slice(0, 200),
          });
        }

        // Track tool calls
        if (event.type === "tool_call" || event.type === "function_call") {
          await emitAgentEvent(journal, sessionId, "agent.tool_call", {
            agent_type: "openai-codex",
            invocation_id: invocationId,
            tool_name: event.name ?? event.function?.name ?? "unknown",
          });
        }

        // Capture turn completion
        if (event.type === "turn.completed" || event.type === "completed") {
          finalResult = event.finalResponse
            ? (typeof event.finalResponse === "string" ? event.finalResponse : JSON.stringify(event.finalResponse))
            : event.result
              ? (typeof event.result === "string" ? event.result : JSON.stringify(event.result))
              : finalResult;
          if (event.usage) usage = event.usage;
        }
      }

      if (ac.signal.aborted) {
        const duration = Date.now() - startTime;
        await emitAgentEvent(journal, sessionId, "agent.aborted", {
          agent_type: "openai-codex",
          invocation_id: invocationId,
          duration_ms: duration,
        });
        return {
          status: "aborted",
          result: "Agent was aborted",
          is_error: true,
          duration_ms: duration,
          usage,
          items_count: itemsCount,
        };
      }

      const duration = Date.now() - startTime;
      await emitAgentEvent(journal, sessionId, "agent.completed", {
        agent_type: "openai-codex",
        invocation_id: invocationId,
        duration_ms: duration,
        items_count: itemsCount,
      });

      return {
        status: "completed",
        result: finalResult,
        is_error: false,
        duration_ms: duration,
        usage,
        items_count: itemsCount,
      };
    } catch (err) {
      const duration = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (ac.signal.aborted) {
        await emitAgentEvent(journal, sessionId, "agent.aborted", {
          agent_type: "openai-codex",
          invocation_id: invocationId,
          duration_ms: duration,
        });
        return {
          status: "aborted",
          result: "Agent was aborted",
          is_error: true,
          duration_ms: duration,
          usage: {},
          items_count: 0,
        };
      }

      await emitAgentEvent(journal, sessionId, "agent.failed", {
        agent_type: "openai-codex",
        invocation_id: invocationId,
        error: errorMessage,
        duration_ms: duration,
      });

      return {
        status: "failed",
        result: errorMessage,
        is_error: true,
        duration_ms: duration,
        usage: {},
        items_count: 0,
      };
    } finally {
      clearTimeout(internalTimeout);
      _activeAgents.delete(invocationId);
    }
  };
}

/**
 * Abort all active OpenAI Codex agents for a session.
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
