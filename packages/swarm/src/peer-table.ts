import type { PeerEntry, PeerStatus, SwarmNodeIdentity } from "./types.js";

export interface SweepThresholds {
  suspected_after_ms: number;
  unreachable_after_ms: number;
  evict_after_ms: number;
}

export class PeerTable {
  private peers = new Map<string, PeerEntry>();
  private maxPeers: number;

  constructor(maxPeers = 50) {
    this.maxPeers = maxPeers;
  }

  add(identity: SwarmNodeIdentity): PeerEntry {
    const existing = this.peers.get(identity.node_id);
    if (existing) {
      existing.identity = identity;
      existing.status = "active";
      existing.last_heartbeat_at = new Date().toISOString();
      existing.consecutive_failures = 0;
      return existing;
    }

    if (this.peers.size >= this.maxPeers) {
      throw new Error(`Peer table full (max ${this.maxPeers})`);
    }

    const now = new Date().toISOString();
    const entry: PeerEntry = {
      identity,
      status: "active",
      last_heartbeat_at: now,
      last_latency_ms: 0,
      consecutive_failures: 0,
      joined_at: now,
    };
    this.peers.set(identity.node_id, entry);
    return entry;
  }

  remove(nodeId: string): boolean {
    return this.peers.delete(nodeId);
  }

  get(nodeId: string): PeerEntry | undefined {
    return this.peers.get(nodeId);
  }

  getAll(): PeerEntry[] {
    return [...this.peers.values()];
  }

  getActive(): PeerEntry[] {
    return [...this.peers.values()].filter((p) => p.status === "active");
  }

  getByCapability(capability: string): PeerEntry[] {
    return this.getActive().filter((p) => p.identity.capabilities.includes(capability));
  }

  getByStatus(status: PeerStatus): PeerEntry[] {
    return [...this.peers.values()].filter((p) => p.status === status);
  }

  recordHeartbeat(nodeId: string, latencyMs: number): boolean {
    const peer = this.peers.get(nodeId);
    if (!peer) return false;
    peer.status = "active";
    peer.last_heartbeat_at = new Date().toISOString();
    peer.last_latency_ms = latencyMs;
    peer.consecutive_failures = 0;
    return true;
  }

  recordFailure(nodeId: string): number {
    const peer = this.peers.get(nodeId);
    if (!peer) return -1;
    peer.consecutive_failures++;
    return peer.consecutive_failures;
  }

  markLeft(nodeId: string): boolean {
    const peer = this.peers.get(nodeId);
    if (!peer) return false;
    peer.status = "left";
    return true;
  }

  /** Sweep peers based on heartbeat age. Returns arrays of state transitions. */
  sweep(thresholds: SweepThresholds): {
    suspected: string[];
    unreachable: string[];
    evicted: string[];
  } {
    const now = Date.now();
    const suspected: string[] = [];
    const unreachable: string[] = [];
    const evicted: string[] = [];

    for (const [nodeId, peer] of this.peers) {
      if (peer.status === "left") continue;

      const age = now - new Date(peer.last_heartbeat_at).getTime();

      if (age >= thresholds.evict_after_ms) {
        this.peers.delete(nodeId);
        evicted.push(nodeId);
      } else if (age >= thresholds.unreachable_after_ms && peer.status !== "unreachable") {
        peer.status = "unreachable";
        unreachable.push(nodeId);
      } else if (age >= thresholds.suspected_after_ms && peer.status === "active") {
        peer.status = "suspected";
        suspected.push(nodeId);
      }
    }

    return { suspected, unreachable, evicted };
  }

  get size(): number {
    return this.peers.size;
  }

  clear(): void {
    this.peers.clear();
  }
}
