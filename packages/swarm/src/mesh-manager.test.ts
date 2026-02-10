import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MeshManager } from "./mesh-manager.js";
import type { SwarmConfig, SwarmNodeIdentity, SwarmTaskRequest, SwarmTaskResult } from "./types.js";
import { DEFAULT_SWARM_CONFIG } from "./types.js";

function makeConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    ...DEFAULT_SWARM_CONFIG,
    api_url: "http://localhost:3100",
    capabilities: ["read-file", "shell-exec"],
    heartbeat_interval_ms: 100000, // large to prevent auto-fire
    sweep_interval_ms: 100000,
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<SwarmNodeIdentity> = {}): SwarmNodeIdentity {
  return {
    node_id: overrides.node_id ?? "remote-1",
    display_name: overrides.display_name ?? "Remote",
    api_url: overrides.api_url ?? "http://remote:3100",
    capabilities: overrides.capabilities ?? ["read-file"],
    version: overrides.version ?? "0.1.0",
  };
}

describe("MeshManager", () => {
  let mesh: MeshManager;

  beforeEach(() => {
    mesh = new MeshManager({
      config: makeConfig({ mdns: false, seeds: [] }),
    });
  });

  afterEach(async () => {
    if (mesh.isRunning) {
      await mesh.stop();
    }
  });

  it("should start and stop cleanly", async () => {
    expect(mesh.isRunning).toBe(false);
    await mesh.start();
    expect(mesh.isRunning).toBe(true);
    await mesh.stop();
    expect(mesh.isRunning).toBe(false);
  });

  it("should not double-start", async () => {
    await mesh.start();
    await mesh.start();
    expect(mesh.isRunning).toBe(true);
  });

  it("should generate a node identity", () => {
    const identity = mesh.getIdentity();
    expect(identity.node_id).toBeTruthy();
    expect(identity.display_name).toBe("karnevil9-node");
    expect(identity.api_url).toBe("http://localhost:3100");
  });

  it("should handle peer join", async () => {
    await mesh.start();
    const entry = mesh.handleJoin(makeIdentity());
    expect(entry.status).toBe("active");
    expect(mesh.peerCount).toBe(1);
    expect(mesh.getPeer("remote-1")).toBeTruthy();
  });

  it("should handle peer leave", async () => {
    await mesh.start();
    mesh.handleJoin(makeIdentity());
    mesh.handleLeave("remote-1");
    expect(mesh.getPeer("remote-1")?.status).toBe("left");
  });

  it("should handle heartbeat", async () => {
    await mesh.start();
    mesh.handleJoin(makeIdentity());
    const result = mesh.handleHeartbeat(
      { node_id: "remote-1", timestamp: new Date().toISOString(), active_sessions: 1, load: 0.3 },
      25,
    );
    expect(result).toBe(true);
    expect(mesh.getPeer("remote-1")?.last_latency_ms).toBe(25);
  });

  it("should return false for heartbeat from unknown peer", async () => {
    await mesh.start();
    const result = mesh.handleHeartbeat(
      { node_id: "unknown", timestamp: new Date().toISOString(), active_sessions: 0, load: 0 },
      10,
    );
    expect(result).toBe(false);
  });

  it("should handle gossip exchange", async () => {
    await mesh.start();
    mesh.handleJoin(makeIdentity({ node_id: "peer-a", api_url: "http://peer-a:3100" }));

    const response = mesh.handleGossip({
      sender_node_id: "peer-a",
      peers: [{ node_id: "peer-b", api_url: "http://peer-b:3100", status: "active" }],
    });

    expect(response.sender_node_id).toBe(mesh.getIdentity().node_id);
    expect(response.peers).toHaveLength(1); // peer-a
  });

  it("should accept task requests via callback", async () => {
    const taskHandler = vi.fn().mockResolvedValue({ accepted: true });
    mesh = new MeshManager({
      config: makeConfig({ mdns: false, seeds: [] }),
      onTaskRequest: taskHandler,
    });
    await mesh.start();

    const request: SwarmTaskRequest = {
      task_id: "task-1",
      originator_node_id: "remote-1",
      originator_session_id: "session-1",
      task_text: "Test task",
      correlation_id: "corr-1",
      nonce: "nonce-1",
    };

    const result = await mesh.handleTaskRequest(request);
    expect(result.accepted).toBe(true);
    expect(taskHandler).toHaveBeenCalledWith(request);
  });

  it("should reject tasks when no handler configured", async () => {
    await mesh.start();
    const request: SwarmTaskRequest = {
      task_id: "task-1",
      originator_node_id: "remote-1",
      originator_session_id: "session-1",
      task_text: "Test task",
      correlation_id: "corr-1",
      nonce: "nonce-1",
    };

    const result = await mesh.handleTaskRequest(request);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("does not accept");
  });

  it("should reject replayed nonces", async () => {
    const taskHandler = vi.fn().mockResolvedValue({ accepted: true });
    mesh = new MeshManager({
      config: makeConfig({ mdns: false, seeds: [] }),
      onTaskRequest: taskHandler,
    });
    await mesh.start();

    const request: SwarmTaskRequest = {
      task_id: "task-1",
      originator_node_id: "remote-1",
      originator_session_id: "session-1",
      task_text: "Test task",
      correlation_id: "corr-1",
      nonce: "replay-nonce",
    };

    await mesh.handleTaskRequest(request);
    const replay = await mesh.handleTaskRequest({ ...request, task_id: "task-2" });
    expect(replay.accepted).toBe(false);
    expect(replay.reason).toContain("Replayed");
  });

  it("should handle task results via callback", async () => {
    const resultHandler = vi.fn();
    mesh = new MeshManager({
      config: makeConfig({ mdns: false, seeds: [] }),
      onTaskResult: resultHandler,
    });
    await mesh.start();

    const result: SwarmTaskResult = {
      task_id: "task-1",
      peer_node_id: "remote-1",
      peer_session_id: "session-1",
      status: "completed",
      findings: [],
      tokens_used: 100,
      cost_usd: 0.01,
      duration_ms: 5000,
    };

    mesh.handleTaskResult(result);
    expect(resultHandler).toHaveBeenCalledWith(result);
  });

  it("should delegate task to a peer", async () => {
    await mesh.start();
    mesh.handleJoin(makeIdentity());

    vi.spyOn(mesh.getTransport(), "sendTaskRequest").mockResolvedValue({
      ok: true,
      status: 200,
      data: { accepted: true },
      latency_ms: 10,
    });

    const result = await mesh.delegateTask("remote-1", "Do something", "session-1");
    expect(result.accepted).toBe(true);
    expect(result.taskId).toBeTruthy();
  });

  it("should fail delegation to non-active peer", async () => {
    await mesh.start();
    const result = await mesh.delegateTask("nonexistent", "Do something", "session-1");
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("not active");
  });

  it("should fail delegation when peer rejects", async () => {
    await mesh.start();
    mesh.handleJoin(makeIdentity());

    vi.spyOn(mesh.getTransport(), "sendTaskRequest").mockResolvedValue({
      ok: true,
      status: 200,
      data: { accepted: false, reason: "Busy" },
      latency_ms: 10,
    });

    const result = await mesh.delegateTask("remote-1", "Do something", "session-1");
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("Busy");
  });

  it("should return active peers", async () => {
    await mesh.start();
    mesh.handleJoin(makeIdentity({ node_id: "a" }));
    mesh.handleJoin(makeIdentity({ node_id: "b" }));
    const entry = mesh.getPeer("b");
    if (entry) entry.status = "suspected";

    expect(mesh.getActivePeers()).toHaveLength(1);
    expect(mesh.getPeers()).toHaveLength(2);
  });

  it("should return peers by capability", async () => {
    await mesh.start();
    mesh.handleJoin(makeIdentity({ node_id: "a", capabilities: ["read-file"] }));
    mesh.handleJoin(makeIdentity({ node_id: "b", capabilities: ["shell-exec"] }));

    expect(mesh.getPeersByCapability("read-file")).toHaveLength(1);
    expect(mesh.getPeersByCapability("browser")).toHaveLength(0);
  });

  it("should track active sessions", async () => {
    await mesh.start();
    mesh.setActiveSessions(3);
    // Value is used in heartbeats - just verify it doesn't throw
    expect(mesh.isRunning).toBe(true);
  });

  it("should handle delegation failure from transport error", async () => {
    await mesh.start();
    mesh.handleJoin(makeIdentity());

    vi.spyOn(mesh.getTransport(), "sendTaskRequest").mockResolvedValue({
      ok: false,
      status: 0,
      error: "ECONNREFUSED",
      latency_ms: 10,
    });

    const result = await mesh.delegateTask("remote-1", "Do something", "session-1");
    expect(result.accepted).toBe(false);
  });

  it("should notify leave to peers on stop", async () => {
    await mesh.start();
    mesh.handleJoin(makeIdentity());

    const sendLeaveSpy = vi.spyOn(mesh.getTransport(), "sendLeave").mockResolvedValue({
      ok: true,
      status: 200,
      latency_ms: 5,
    });

    await mesh.stop();
    expect(sendLeaveSpy).toHaveBeenCalledTimes(1);
  });
});
