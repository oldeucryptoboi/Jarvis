import { v4 as uuid } from "uuid";
import type {
  SwarmTaskResult,
  ActiveDelegation,
  DistributionStrategy,
  PeerEntry,
  SwarmTaskConstraints,
} from "./types.js";
import type { MeshManager } from "./mesh-manager.js";

export interface WorkDistributorConfig {
  meshManager: MeshManager;
  strategy: DistributionStrategy;
  delegation_timeout_ms: number;
  max_retries: number;
}

export class WorkDistributor {
  private meshManager: MeshManager;
  private strategy: DistributionStrategy;
  private delegationTimeoutMs: number;
  private maxRetries: number;
  private activeDelegations = new Map<string, ActiveDelegation>();
  private roundRobinIndex = 0;

  constructor(config: WorkDistributorConfig) {
    this.meshManager = config.meshManager;
    this.strategy = config.strategy;
    this.delegationTimeoutMs = config.delegation_timeout_ms;
    this.maxRetries = config.max_retries;
  }

  /**
   * Distribute a task to a suitable peer. Returns the result when the peer completes it.
   * Rejects if no peer accepts or if delegation times out.
   */
  async distribute(
    taskText: string,
    sessionId: string,
    constraints?: SwarmTaskConstraints,
  ): Promise<SwarmTaskResult> {
    const peers = this.selectPeers(constraints);
    if (peers.length === 0) {
      throw new Error("No suitable peers available for task distribution");
    }

    let lastError: Error | undefined;
    let attempts = 0;

    for (const peer of peers) {
      if (attempts >= this.maxRetries + 1) break;
      attempts++;

      try {
        const result = await this.delegateToPeer(peer, taskText, sessionId, constraints);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error("Failed to distribute task to any peer");
  }

  /** Resolve a delegation when a result arrives from a peer. */
  resolveTask(result: SwarmTaskResult): boolean {
    const delegation = this.findDelegationByTaskId(result.task_id);
    if (!delegation) return false;

    clearTimeout(delegation.timer);
    this.activeDelegations.delete(delegation.task_id);
    delegation.resolve(result);
    return true;
  }

  /** Get the number of active delegations. */
  get activeCount(): number {
    return this.activeDelegations.size;
  }

  /** Get active delegation info (for diagnostics). */
  getActiveDelegations(): Array<{ task_id: string; peer_node_id: string; elapsed_ms: number }> {
    return [...this.activeDelegations.values()].map((d) => ({
      task_id: d.task_id,
      peer_node_id: d.peer_node_id,
      elapsed_ms: Date.now() - d.sent_at,
    }));
  }

  /** Cancel all active delegations. */
  cancelAll(): void {
    for (const [, delegation] of this.activeDelegations) {
      clearTimeout(delegation.timer);
      delegation.reject(new Error("Delegation cancelled"));
    }
    this.activeDelegations.clear();
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private selectPeers(constraints?: SwarmTaskConstraints): PeerEntry[] {
    let candidates: PeerEntry[];

    if (this.strategy === "capability_match" && constraints?.tool_allowlist?.length) {
      // Find peers that have at least one required capability
      const required = constraints.tool_allowlist;
      candidates = this.meshManager.getActivePeers().filter((peer) =>
        required.some((tool) => peer.identity.capabilities.includes(tool)),
      );
    } else {
      candidates = this.meshManager.getActivePeers();
    }

    if (this.strategy === "round_robin" && candidates.length > 0) {
      // Rotate through peers starting at current index
      const rotated: PeerEntry[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const idx = (this.roundRobinIndex + i) % candidates.length;
        rotated.push(candidates[idx]!);
      }
      this.roundRobinIndex = (this.roundRobinIndex + 1) % candidates.length;
      return rotated;
    }

    return candidates;
  }

  private async delegateToPeer(
    peer: PeerEntry,
    taskText: string,
    sessionId: string,
    constraints?: SwarmTaskConstraints,
  ): Promise<SwarmTaskResult> {
    const delegateResult = await this.meshManager.delegateTask(
      peer.identity.node_id,
      taskText,
      sessionId,
      constraints,
    );

    if (!delegateResult.accepted) {
      throw new Error(`Peer ${peer.identity.node_id} rejected: ${delegateResult.reason}`);
    }

    const taskId = delegateResult.taskId;

    return new Promise<SwarmTaskResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeDelegations.delete(taskId);
        reject(new Error(`Delegation to ${peer.identity.node_id} timed out after ${this.delegationTimeoutMs}ms`));
      }, this.delegationTimeoutMs);
      timer.unref();

      const delegation: ActiveDelegation = {
        task_id: taskId,
        peer_node_id: peer.identity.node_id,
        correlation_id: uuid(),
        sent_at: Date.now(),
        timeout_ms: this.delegationTimeoutMs,
        resolve,
        reject,
        timer,
      };

      this.activeDelegations.set(taskId, delegation);
    });
  }

  private findDelegationByTaskId(taskId: string): ActiveDelegation | undefined {
    return this.activeDelegations.get(taskId);
  }
}
