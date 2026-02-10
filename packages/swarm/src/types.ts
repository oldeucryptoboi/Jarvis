import type { CheckpointFinding } from "@karnevil9/schemas";

// ─── Node Identity ──────────────────────────────────────────────────

export interface SwarmNodeIdentity {
  node_id: string;
  display_name: string;
  api_url: string;
  capabilities: string[];
  version: string;
}

// ─── Peer Status ────────────────────────────────────────────────────

export type PeerStatus = "active" | "suspected" | "unreachable" | "left";

export interface PeerEntry {
  identity: SwarmNodeIdentity;
  status: PeerStatus;
  last_heartbeat_at: string;
  last_latency_ms: number;
  consecutive_failures: number;
  joined_at: string;
}

// ─── Task Delegation ────────────────────────────────────────────────

export interface SwarmTaskConstraints {
  tool_allowlist?: string[];
  max_tokens?: number;
  max_cost_usd?: number;
  max_duration_ms?: number;
}

export interface SwarmTaskRequest {
  task_id: string;
  originator_node_id: string;
  originator_session_id: string;
  task_text: string;
  constraints?: SwarmTaskConstraints;
  correlation_id: string;
  nonce: string;
}

export interface SwarmTaskResult {
  task_id: string;
  peer_node_id: string;
  peer_session_id: string;
  status: "completed" | "failed" | "aborted";
  findings: CheckpointFinding[];
  tokens_used: number;
  cost_usd: number;
  duration_ms: number;
}

// ─── Messages ───────────────────────────────────────────────────────

export interface HeartbeatMessage {
  node_id: string;
  timestamp: string;
  active_sessions: number;
  load: number;
}

export interface GossipMessage {
  sender_node_id: string;
  peers: Array<{ node_id: string; api_url: string; status: PeerStatus }>;
}

export interface JoinMessage {
  identity: SwarmNodeIdentity;
}

export interface LeaveMessage {
  node_id: string;
  reason?: string;
}

// ─── Configuration ──────────────────────────────────────────────────

export type DistributionStrategy = "round_robin" | "capability_match";

export interface SwarmConfig {
  enabled: boolean;
  token?: string;
  node_name: string;
  api_url: string;
  seeds: string[];
  mdns: boolean;
  gossip: boolean;
  max_peers: number;
  heartbeat_interval_ms: number;
  sweep_interval_ms: number;
  suspected_after_ms: number;
  unreachable_after_ms: number;
  evict_after_ms: number;
  delegation_timeout_ms: number;
  nonce_window_ms: number;
  version: string;
  capabilities: string[];
}

export const DEFAULT_SWARM_CONFIG: Omit<SwarmConfig, "api_url" | "capabilities"> = {
  enabled: false,
  node_name: "karnevil9-node",
  seeds: [],
  mdns: true,
  gossip: true,
  max_peers: 50,
  heartbeat_interval_ms: 5000,
  sweep_interval_ms: 10000,
  suspected_after_ms: 15000,
  unreachable_after_ms: 30000,
  evict_after_ms: 120000,
  delegation_timeout_ms: 300000,
  nonce_window_ms: 300000,
  version: "0.1.0",
};

// ─── Session Factory ────────────────────────────────────────────────

export type SessionFactory = (task: { task_id: string; text: string; created_at: string }) => Promise<{
  session_id: string;
  status: string;
}>;

// ─── Active Delegation ──────────────────────────────────────────────

export interface ActiveDelegation {
  task_id: string;
  peer_node_id: string;
  correlation_id: string;
  sent_at: number;
  timeout_ms: number;
  resolve: (result: SwarmTaskResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
