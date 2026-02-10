import { describe, it, expect, beforeEach, vi } from "vitest";
import { PeerDiscovery } from "./discovery.js";
import { PeerTransport } from "./transport.js";
import type { SwarmNodeIdentity } from "./types.js";

function makeIdentity(overrides: Partial<SwarmNodeIdentity> = {}): SwarmNodeIdentity {
  return {
    node_id: overrides.node_id ?? "local-1",
    display_name: overrides.display_name ?? "Local",
    api_url: overrides.api_url ?? "http://localhost:3100",
    capabilities: overrides.capabilities ?? ["read-file"],
    version: overrides.version ?? "0.1.0",
  };
}

describe("PeerDiscovery", () => {
  let transport: PeerTransport;
  let discovered: SwarmNodeIdentity[];
  let discovery: PeerDiscovery;

  beforeEach(() => {
    transport = new PeerTransport();
    discovered = [];
    discovery = new PeerDiscovery({
      mdns: false,
      seeds: [],
      gossip: true,
      localIdentity: makeIdentity(),
      transport,
      onPeerDiscovered: (identity) => discovered.push(identity),
    });
  });

  it("should start and stop cleanly", async () => {
    expect(discovery.isStarted).toBe(false);
    await discovery.start();
    expect(discovery.isStarted).toBe(true);
    await discovery.stop();
    expect(discovery.isStarted).toBe(false);
  });

  it("should not double-start", async () => {
    await discovery.start();
    await discovery.start(); // Should be no-op
    expect(discovery.isStarted).toBe(true);
  });

  it("should count local node as known", async () => {
    await discovery.start();
    expect(discovery.knownNodeCount).toBe(1);
  });

  it("should discover peers from seeds", async () => {
    const remoteIdentity = makeIdentity({ node_id: "remote-1", api_url: "http://remote:3100" });
    vi.spyOn(transport, "fetchIdentity").mockResolvedValue({
      ok: true,
      status: 200,
      data: remoteIdentity,
      latency_ms: 10,
    });

    discovery = new PeerDiscovery({
      mdns: false,
      seeds: ["http://remote:3100"],
      gossip: true,
      localIdentity: makeIdentity(),
      transport,
      onPeerDiscovered: (identity) => discovered.push(identity),
    });

    await discovery.start();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.node_id).toBe("remote-1");
    expect(discovery.knownNodeCount).toBe(2); // local + remote
  });

  it("should not rediscover already-known peers from seeds", async () => {
    const remoteIdentity = makeIdentity({ node_id: "remote-1", api_url: "http://remote:3100" });
    vi.spyOn(transport, "fetchIdentity").mockResolvedValue({
      ok: true,
      status: 200,
      data: remoteIdentity,
      latency_ms: 10,
    });

    discovery = new PeerDiscovery({
      mdns: false,
      seeds: ["http://remote:3100"],
      gossip: true,
      localIdentity: makeIdentity(),
      transport,
      onPeerDiscovered: (identity) => discovered.push(identity),
    });

    await discovery.start();
    expect(discovered).toHaveLength(1);

    // Calling discoverFromSeeds again should not fire callback
    discovered.length = 0;
    await discovery.discoverFromSeeds();
    expect(discovered).toHaveLength(0);
  });

  it("should handle seed fetch failures gracefully", async () => {
    vi.spyOn(transport, "fetchIdentity").mockResolvedValue({
      ok: false,
      status: 0,
      error: "ECONNREFUSED",
      latency_ms: 5,
    });

    discovery = new PeerDiscovery({
      mdns: false,
      seeds: ["http://unreachable:3100"],
      gossip: true,
      localIdentity: makeIdentity(),
      transport,
      onPeerDiscovered: (identity) => discovered.push(identity),
    });

    await discovery.start();
    expect(discovered).toHaveLength(0);
  });

  it("should process gossip and discover new peers", async () => {
    const peerX = makeIdentity({ node_id: "peer-x", api_url: "http://peer-x:3100" });
    vi.spyOn(transport, "fetchIdentity").mockResolvedValue({
      ok: true,
      status: 200,
      data: peerX,
      latency_ms: 5,
    });

    await discovery.start();
    const result = await discovery.processGossip([
      { node_id: "peer-x", api_url: "http://peer-x:3100" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]!.node_id).toBe("peer-x");
    expect(discovered).toHaveLength(1);
  });

  it("should skip already-known peers in gossip", async () => {
    vi.spyOn(transport, "fetchIdentity");

    await discovery.start();
    discovery.markKnown("peer-x");

    const result = await discovery.processGossip([
      { node_id: "peer-x", api_url: "http://peer-x:3100" },
    ]);

    expect(result).toHaveLength(0);
    expect(transport.fetchIdentity).not.toHaveBeenCalled();
  });

  it("should not process gossip when gossip is disabled", async () => {
    discovery = new PeerDiscovery({
      mdns: false,
      seeds: [],
      gossip: false,
      localIdentity: makeIdentity(),
      transport,
      onPeerDiscovered: (identity) => discovered.push(identity),
    });

    await discovery.start();
    const result = await discovery.processGossip([
      { node_id: "peer-x", api_url: "http://peer-x:3100" },
    ]);

    expect(result).toHaveLength(0);
  });

  it("should handle gossip fetch failures gracefully", async () => {
    vi.spyOn(transport, "fetchIdentity").mockResolvedValue({
      ok: false,
      status: 0,
      error: "ECONNREFUSED",
      latency_ms: 5,
    });

    await discovery.start();
    const result = await discovery.processGossip([
      { node_id: "peer-x", api_url: "http://peer-x:3100" },
    ]);

    expect(result).toHaveLength(0);
  });

  it("should forget a node and allow rediscovery", async () => {
    const peerX = makeIdentity({ node_id: "peer-x", api_url: "http://peer-x:3100" });
    vi.spyOn(transport, "fetchIdentity").mockResolvedValue({
      ok: true,
      status: 200,
      data: peerX,
      latency_ms: 5,
    });

    await discovery.start();
    await discovery.processGossip([{ node_id: "peer-x", api_url: "http://peer-x:3100" }]);
    expect(discovered).toHaveLength(1);

    discovered.length = 0;
    discovery.forget("peer-x");
    await discovery.processGossip([{ node_id: "peer-x", api_url: "http://peer-x:3100" }]);
    expect(discovered).toHaveLength(1);
  });

  it("should clear discovered set on stop", async () => {
    await discovery.start();
    discovery.markKnown("peer-a");
    discovery.markKnown("peer-b");
    expect(discovery.knownNodeCount).toBe(3); // local + a + b
    await discovery.stop();
    expect(discovery.knownNodeCount).toBe(0);
  });

  it("should not discover self from seeds", async () => {
    vi.spyOn(transport, "fetchIdentity").mockResolvedValue({
      ok: true,
      status: 200,
      data: makeIdentity(), // Same node_id as local
      latency_ms: 5,
    });

    discovery = new PeerDiscovery({
      mdns: false,
      seeds: ["http://localhost:3100"],
      gossip: true,
      localIdentity: makeIdentity(),
      transport,
      onPeerDiscovered: (identity) => discovered.push(identity),
    });

    await discovery.start();
    expect(discovered).toHaveLength(0);
  });
});
