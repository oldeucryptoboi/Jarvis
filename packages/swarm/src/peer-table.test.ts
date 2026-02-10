import { describe, it, expect, beforeEach } from "vitest";
import { PeerTable } from "./peer-table.js";
import type { SwarmNodeIdentity } from "./types.js";

function makeIdentity(overrides: Partial<SwarmNodeIdentity> = {}): SwarmNodeIdentity {
  return {
    node_id: overrides.node_id ?? "node-1",
    display_name: overrides.display_name ?? "Test Node",
    api_url: overrides.api_url ?? "http://localhost:3100",
    capabilities: overrides.capabilities ?? ["read-file", "shell-exec"],
    version: overrides.version ?? "0.1.0",
  };
}

describe("PeerTable", () => {
  let table: PeerTable;

  beforeEach(() => {
    table = new PeerTable(5);
  });

  it("should add a peer and retrieve it", () => {
    const entry = table.add(makeIdentity());
    expect(entry.identity.node_id).toBe("node-1");
    expect(entry.status).toBe("active");
    expect(table.size).toBe(1);
  });

  it("should return existing peer on re-add and reset status", () => {
    const entry = table.add(makeIdentity());
    entry.status = "suspected";
    entry.consecutive_failures = 3;
    const updated = table.add(makeIdentity({ display_name: "Updated" }));
    expect(updated.identity.display_name).toBe("Updated");
    expect(updated.status).toBe("active");
    expect(updated.consecutive_failures).toBe(0);
    expect(table.size).toBe(1);
  });

  it("should throw when peer table is full", () => {
    for (let i = 0; i < 5; i++) {
      table.add(makeIdentity({ node_id: `node-${i}` }));
    }
    expect(() => table.add(makeIdentity({ node_id: "node-overflow" }))).toThrow("Peer table full");
  });

  it("should remove a peer", () => {
    table.add(makeIdentity());
    expect(table.remove("node-1")).toBe(true);
    expect(table.size).toBe(0);
    expect(table.remove("nonexistent")).toBe(false);
  });

  it("should get a peer by id", () => {
    table.add(makeIdentity());
    expect(table.get("node-1")?.identity.node_id).toBe("node-1");
    expect(table.get("nonexistent")).toBeUndefined();
  });

  it("should return all peers", () => {
    table.add(makeIdentity({ node_id: "a" }));
    table.add(makeIdentity({ node_id: "b" }));
    expect(table.getAll()).toHaveLength(2);
  });

  it("should return only active peers", () => {
    table.add(makeIdentity({ node_id: "a" }));
    const b = table.add(makeIdentity({ node_id: "b" }));
    b.status = "suspected";
    expect(table.getActive()).toHaveLength(1);
    expect(table.getActive()[0]!.identity.node_id).toBe("a");
  });

  it("should filter peers by capability", () => {
    table.add(makeIdentity({ node_id: "a", capabilities: ["read-file"] }));
    table.add(makeIdentity({ node_id: "b", capabilities: ["shell-exec"] }));
    table.add(makeIdentity({ node_id: "c", capabilities: ["read-file", "shell-exec"] }));
    const readers = table.getByCapability("read-file");
    expect(readers).toHaveLength(2);
    expect(readers.map((p) => p.identity.node_id).sort()).toEqual(["a", "c"]);
  });

  it("should filter peers by status", () => {
    const a = table.add(makeIdentity({ node_id: "a" }));
    table.add(makeIdentity({ node_id: "b" }));
    a.status = "unreachable";
    expect(table.getByStatus("unreachable")).toHaveLength(1);
    expect(table.getByStatus("active")).toHaveLength(1);
  });

  it("should record heartbeat and update peer state", () => {
    table.add(makeIdentity());
    const peer = table.get("node-1")!;
    peer.status = "suspected";
    peer.consecutive_failures = 5;
    expect(table.recordHeartbeat("node-1", 42)).toBe(true);
    expect(peer.status).toBe("active");
    expect(peer.last_latency_ms).toBe(42);
    expect(peer.consecutive_failures).toBe(0);
  });

  it("should return false for heartbeat on unknown peer", () => {
    expect(table.recordHeartbeat("nonexistent", 10)).toBe(false);
  });

  it("should record failures", () => {
    table.add(makeIdentity());
    expect(table.recordFailure("node-1")).toBe(1);
    expect(table.recordFailure("node-1")).toBe(2);
    expect(table.recordFailure("nonexistent")).toBe(-1);
  });

  it("should mark peer as left", () => {
    table.add(makeIdentity());
    expect(table.markLeft("node-1")).toBe(true);
    expect(table.get("node-1")!.status).toBe("left");
    expect(table.markLeft("nonexistent")).toBe(false);
  });

  describe("sweep", () => {
    const thresholds = {
      suspected_after_ms: 15000,
      unreachable_after_ms: 30000,
      evict_after_ms: 120000,
    };

    it("should transition active → suspected", () => {
      table.add(makeIdentity({ node_id: "a" }));
      const peer = table.get("a")!;
      peer.last_heartbeat_at = new Date(Date.now() - 20000).toISOString();
      const result = table.sweep(thresholds);
      expect(result.suspected).toEqual(["a"]);
      expect(peer.status).toBe("suspected");
    });

    it("should transition to unreachable", () => {
      table.add(makeIdentity({ node_id: "a" }));
      const peer = table.get("a")!;
      peer.last_heartbeat_at = new Date(Date.now() - 35000).toISOString();
      const result = table.sweep(thresholds);
      expect(result.unreachable).toEqual(["a"]);
      expect(peer.status).toBe("unreachable");
    });

    it("should evict peers past eviction threshold", () => {
      table.add(makeIdentity({ node_id: "a" }));
      const peer = table.get("a")!;
      peer.last_heartbeat_at = new Date(Date.now() - 130000).toISOString();
      const result = table.sweep(thresholds);
      expect(result.evicted).toEqual(["a"]);
      expect(table.size).toBe(0);
    });

    it("should skip peers with status left", () => {
      table.add(makeIdentity({ node_id: "a" }));
      table.get("a")!.status = "left";
      table.get("a")!.last_heartbeat_at = new Date(Date.now() - 130000).toISOString();
      const result = table.sweep(thresholds);
      expect(result.suspected).toEqual([]);
      expect(result.unreachable).toEqual([]);
      expect(result.evicted).toEqual([]);
    });
  });

  it("should clear all peers", () => {
    table.add(makeIdentity({ node_id: "a" }));
    table.add(makeIdentity({ node_id: "b" }));
    table.clear();
    expect(table.size).toBe(0);
  });
});
