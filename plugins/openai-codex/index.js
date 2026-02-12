/**
 * OpenAI Codex Plugin — delegates coding tasks to OpenAI Codex via the Codex SDK.
 *
 * Follows the Slack/Swarm plugin pattern: tool registration, before_plan hook for
 * planner awareness, journal progress streaming, graceful degradation, and status routes.
 */
import { openaiCodexManifest, createOpenaiCodexHandler, abortSessionAgents, getActiveCount } from "./tool.js";

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const config = api.config;

  // ── Resolve API key (env var with config fallback) ──
  const apiKey = process.env.OPENAI_API_KEY ?? config.apiKey;
  const model = config.model ?? process.env.KARNEVIL9_CODEX_MODEL;
  const journal = config.journal;

  if (!apiKey) {
    api.logger.warn("No OPENAI_API_KEY set — OpenAI Codex plugin will register stubs (graceful degradation)");
    _registerStubs(api);
    return;
  }

  // ── Register tool ──
  const handler = createOpenaiCodexHandler({ journal, apiKey, model });
  api.registerTool(openaiCodexManifest, handler);

  // ── Register hooks ──

  // before_plan: inform planner that OpenAI Codex is available
  api.registerHook("before_plan", async () => {
    return {
      action: "modify",
      data: {
        openai_codex_context: {
          available: true,
          hint: "You can use the openai-codex tool to delegate coding tasks to an OpenAI Codex agent. It runs autonomously with full file system access.",
          model: model ?? "default",
        },
      },
    };
  });

  // before_tool_call: inject session/invocation IDs into openai-codex tool calls
  api.registerHook("before_tool_call", async (context) => {
    if (context.tool_name === "openai-codex") {
      return {
        action: "modify",
        data: {
          _session_id: context.session_id,
          _invocation_id: `${context.session_id}:${context.step_id}`,
        },
      };
    }
    return { action: "continue" };
  });

  // after_session_end: abort active agents when session is aborted
  api.registerHook("after_session_end", async (context) => {
    if (context.status === "aborted") {
      const aborted = abortSessionAgents(context.session_id);
      if (aborted > 0) {
        api.logger.info(`Aborted ${aborted} active OpenAI Codex agent(s) for session ${context.session_id}`);
      }
    }
    return { action: "observe" };
  });

  // ── Register routes ──
  api.registerRoute("GET", "status", (_req, res) => {
    res.json({
      available: true,
      model: model ?? "default",
      active_agents: getActiveCount(),
    });
  });

  // ── Register service ──
  api.registerService({
    name: "openai-codex-agent",
    async start() {
      api.logger.info("OpenAI Codex agent service ready", { model: model ?? "default" });
    },
    async stop() {
      api.logger.info("OpenAI Codex agent service stopped");
    },
    async health() {
      return {
        ok: true,
        detail: `API key configured, ${getActiveCount()} active agent(s)`,
      };
    },
  });

  api.logger.info("OpenAI Codex plugin registered");
}

/**
 * Register stubs when API key is missing (so plugin manifest validates).
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
function _registerStubs(api) {
  api.registerTool(openaiCodexManifest, async (input, mode) => {
    if (mode === "mock") {
      return {
        status: "completed",
        result: `[mock] OpenAI Codex would execute: ${input.task}`,
        is_error: false,
        duration_ms: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        items_count: 0,
      };
    }
    return {
      status: "failed",
      result: "OpenAI Codex not configured — OPENAI_API_KEY not set",
      is_error: true,
      duration_ms: 0,
      usage: {},
      items_count: 0,
    };
  });

  api.registerHook("before_plan", async () => ({ action: "continue" }));
  api.registerHook("before_tool_call", async () => ({ action: "continue" }));
  api.registerHook("after_session_end", async () => ({ action: "observe" }));

  api.registerRoute("GET", "status", (_req, res) => {
    res.json({ available: false, reason: "OPENAI_API_KEY not set" });
  });

  api.registerService({
    name: "openai-codex-agent",
    async start() { api.logger.info("OpenAI Codex agent stub — no API key configured"); },
    async stop() {},
    async health() { return { ok: false, detail: "Not configured" }; },
  });
}
