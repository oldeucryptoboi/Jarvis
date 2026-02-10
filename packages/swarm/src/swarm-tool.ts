import type { ToolManifest, ToolHandler } from "@karnevil9/schemas";
import type { MeshManager } from "./mesh-manager.js";
import type { WorkDistributor } from "./work-distributor.js";

export const swarmDistributeManifest: ToolManifest = {
  name: "swarm-distribute",
  version: "1.0.0",
  description: "Delegate a subtask to a peer node in the swarm mesh. The peer runs the task in its own session and returns findings.",
  runner: "internal",
  input_schema: {
    type: "object",
    required: ["task_text"],
    properties: {
      task_text: { type: "string", description: "The subtask description to delegate to a peer" },
      tool_allowlist: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of tools the peer should use",
      },
      max_tokens: { type: "number", description: "Max tokens budget for the peer session" },
      max_cost_usd: { type: "number", description: "Max cost budget for the peer session" },
      max_duration_ms: { type: "number", description: "Max duration for the peer session" },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      status: { type: "string" },
      findings: { type: "array" },
      peer_node_id: { type: "string" },
      tokens_used: { type: "number" },
      cost_usd: { type: "number" },
      duration_ms: { type: "number" },
    },
  },
  permissions: ["swarm:delegate:tasks"],
  timeout_ms: 600000,
  supports: { mock: true, dry_run: true },
};

export const swarmPeersManifest: ToolManifest = {
  name: "swarm-peers",
  version: "1.0.0",
  description: "List active peers in the swarm mesh, with their capabilities and status.",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      status_filter: {
        type: "string",
        enum: ["active", "suspected", "unreachable", "left"],
        description: "Filter peers by status",
      },
      capability_filter: { type: "string", description: "Filter peers by capability" },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      peers: { type: "array" },
      self: { type: "object" },
      total: { type: "number" },
    },
  },
  permissions: ["swarm:read:peers"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
};

export function createSwarmDistributeHandler(
  meshManager: MeshManager,
  workDistributor: WorkDistributor,
): ToolHandler {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return {
        status: "completed",
        findings: [{ step_title: "mock step", tool_name: "mock-tool", status: "succeeded", summary: "mock result" }],
        peer_node_id: "mock-peer",
        tokens_used: 0,
        cost_usd: 0,
        duration_ms: 0,
      };
    }

    if (mode === "dry_run") {
      const peers = meshManager.getActivePeers();
      return {
        dry_run: true,
        would_distribute_to: peers.map((p) => p.identity.node_id),
        available_peers: peers.length,
        task_text: input.task_text,
      };
    }

    const taskText = input.task_text as string;
    if (!taskText || typeof taskText !== "string") {
      throw new Error("task_text is required and must be a string");
    }

    const constraints = {
      tool_allowlist: input.tool_allowlist as string[] | undefined,
      max_tokens: input.max_tokens as number | undefined,
      max_cost_usd: input.max_cost_usd as number | undefined,
      max_duration_ms: input.max_duration_ms as number | undefined,
    };

    // Remove undefined values
    const cleanConstraints = Object.fromEntries(
      Object.entries(constraints).filter(([, v]) => v !== undefined),
    );

    const result = await workDistributor.distribute(
      taskText,
      "swarm-tool", // session_id placeholder — filled in by tool runtime context
      Object.keys(cleanConstraints).length > 0 ? cleanConstraints : undefined,
    );

    return {
      status: result.status,
      findings: result.findings,
      peer_node_id: result.peer_node_id,
      peer_session_id: result.peer_session_id,
      tokens_used: result.tokens_used,
      cost_usd: result.cost_usd,
      duration_ms: result.duration_ms,
    };
  };
}

export function createSwarmPeersHandler(meshManager: MeshManager): ToolHandler {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return {
        self: { node_id: "mock-node", display_name: "Mock", capabilities: [] },
        peers: [],
        total: 0,
      };
    }

    let peers = meshManager.getPeers();

    const statusFilter = input.status_filter as string | undefined;
    if (statusFilter) {
      peers = peers.filter((p) => p.status === statusFilter);
    }

    const capFilter = input.capability_filter as string | undefined;
    if (capFilter) {
      peers = peers.filter((p) => p.identity.capabilities.includes(capFilter));
    }

    return {
      self: meshManager.getIdentity(),
      peers: peers.map((p) => ({
        node_id: p.identity.node_id,
        display_name: p.identity.display_name,
        api_url: p.identity.api_url,
        capabilities: p.identity.capabilities,
        status: p.status,
        last_heartbeat_at: p.last_heartbeat_at,
        last_latency_ms: p.last_latency_ms,
      })),
      total: peers.length,
    };
  };
}
