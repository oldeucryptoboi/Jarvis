import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Journal } from "./journal.js";

const TEST_DIR = resolve(import.meta.dirname ?? ".", "../../.test-data");
const TEST_FILE = resolve(TEST_DIR, "test-journal.jsonl");

describe("Journal", () => {
  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* may not exist */ }
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* cleanup */ }
  });

  it("creates directory and file on init + emit", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    const event = await journal.emit("sess-1", "session.created", { task: "test" });
    expect(event.event_id).toBeTruthy();
    expect(event.session_id).toBe("sess-1");
    expect(event.type).toBe("session.created");
    expect(event.payload).toEqual({ task: "test" });
    expect(existsSync(TEST_FILE)).toBe(true);
  });

  it("reads all events", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-2", "session.created", {});

    const all = await journal.readAll();
    expect(all).toHaveLength(3);
  });

  it("reads events filtered by session", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    const sess1Events = await journal.readSession("sess-1");
    expect(sess1Events).toHaveLength(2);
    expect(sess1Events.every((e) => e.session_id === "sess-1")).toBe(true);
  });

  it("maintains hash chain integrity", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    const e1 = await journal.emit("sess-1", "session.created", {});
    const e2 = await journal.emit("sess-1", "session.started", {});

    expect(e1.hash_prev).toBeUndefined();
    expect(e2.hash_prev).toBeTruthy();

    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("detects broken hash chain", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-1", "session.completed", {});

    // Tamper with the journal file: modify the second line
    const content = await readFile(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    const parsed = JSON.parse(lines[1]!);
    parsed.payload = { tampered: true };
    lines[1] = JSON.stringify(parsed);
    await writeFile(TEST_FILE, lines.join("\n") + "\n", "utf-8");

    const journal2 = new Journal(TEST_FILE, { fsync: false });
    // init() now verifies hash chain and throws on tampering (C3 fix)
    await expect(journal2.init()).rejects.toThrow("Journal integrity violation at event 2");
  });

  it("returns valid integrity for empty journal", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("notifies listeners on emit", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    const received: string[] = [];
    journal.on((event) => { received.push(event.type); });
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    expect(received).toEqual(["session.created", "session.started"]);
  });

  it("supports removing listeners", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    const received: string[] = [];
    const unsub = journal.on((event) => { received.push(event.type); });
    await journal.emit("sess-1", "session.created", {});
    unsub();
    await journal.emit("sess-1", "session.started", {});
    expect(received).toEqual(["session.created"]);
  });

  it("continues when a listener throws", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    const received: string[] = [];
    journal.on(() => { throw new Error("boom"); });
    journal.on((event) => { received.push(event.type); });
    await journal.emit("sess-1", "session.created", {});
    expect(received).toEqual(["session.created"]);
  });

  it("resumes hash chain from existing file", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});

    // Create a new journal instance pointing to the same file
    const journal2 = new Journal(TEST_FILE, { fsync: false });
    await journal2.init();
    await journal2.emit("sess-1", "session.completed", {});

    const integrity = await journal2.verifyIntegrity();
    expect(integrity.valid).toBe(true);
    const all = await journal2.readAll();
    expect(all).toHaveLength(3);
  });

  it("returns empty array for readAll on nonexistent file", async () => {
    const journal = new Journal(resolve(TEST_DIR, "nonexistent.jsonl"));
    await journal.init();
    const events = await journal.readAll();
    expect(events).toEqual([]);
  });

  it("concurrent emits don't corrupt hash chain", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();

    // Fire 20 concurrent emits from different sessions
    const promises = Array.from({ length: 20 }, (_, i) =>
      journal.emit(`sess-${i % 3}`, "session.created", { index: i })
    );
    await Promise.all(promises);

    const events = await journal.readAll();
    expect(events).toHaveLength(20);

    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  // ─── Sequence Number Tests ────────────────────────────────────────

  it("assigns monotonically increasing seq numbers", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    const e1 = await journal.emit("sess-1", "session.created", {});
    const e2 = await journal.emit("sess-1", "session.started", {});
    const e3 = await journal.emit("sess-2", "session.created", {});

    expect(e1.seq).toBe(0);
    expect(e2.seq).toBe(1);
    expect(e3.seq).toBe(2);
  });

  it("resumes seq from max on init (re-open existing journal)", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});

    const journal2 = new Journal(TEST_FILE, { fsync: false });
    await journal2.init();
    const e3 = await journal2.emit("sess-1", "session.completed", {});
    expect(e3.seq).toBe(2);
  });

  it("old events without seq are still readable (backward compat)", async () => {
    // Manually write an event without seq field
    const { mkdirSync } = await import("node:fs");
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    const legacyEvent = JSON.stringify({
      event_id: "legacy-1",
      timestamp: new Date().toISOString(),
      session_id: "sess-old",
      type: "session.created",
      payload: {},
    });
    await writeFile(TEST_FILE, legacyEvent + "\n", "utf-8");

    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    const events = await journal.readSession("sess-old");
    expect(events).toHaveLength(1);
    expect(events[0]!.seq).toBeUndefined();

    // New events should start at seq 0 since no prior seq existed
    const e = await journal.emit("sess-old", "session.started", {});
    expect(e.seq).toBe(0);
  });

  // ─── Session Index Tests ──────────────────────────────────────────

  it("readSession returns correct events after emit (via index)", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-2", "session.started", {});
    await journal.emit("sess-1", "session.completed", {});

    const sess1 = await journal.readSession("sess-1");
    expect(sess1).toHaveLength(3);
    expect(sess1.map((e) => e.type)).toEqual(["session.created", "session.started", "session.completed"]);

    const sess2 = await journal.readSession("sess-2");
    expect(sess2).toHaveLength(2);
  });

  it("readSession with offset/limit paginates correctly", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-1", "session.completed", {});

    const page1 = await journal.readSession("sess-1", { offset: 0, limit: 2 });
    expect(page1).toHaveLength(2);
    expect(page1[0]!.type).toBe("session.created");
    expect(page1[1]!.type).toBe("session.started");

    const page2 = await journal.readSession("sess-1", { offset: 2, limit: 2 });
    expect(page2).toHaveLength(1);
    expect(page2[0]!.type).toBe("session.completed");
  });

  it("getSessionEventCount returns correct count", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    expect(journal.getSessionEventCount("sess-1")).toBe(0);

    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    expect(journal.getSessionEventCount("sess-1")).toBe(2);

    await journal.emit("sess-2", "session.created", {});
    expect(journal.getSessionEventCount("sess-1")).toBe(2);
    expect(journal.getSessionEventCount("sess-2")).toBe(1);
  });

  // ─── Compaction Tests ─────────────────────────────────────────────

  it("compaction removes events for non-retained sessions", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-3", "session.created", {});

    const result = await journal.compact(["sess-1"]);
    expect(result.before).toBe(4);
    expect(result.after).toBe(2);

    const all = await journal.readAll();
    expect(all).toHaveLength(2);
    expect(all.every((e) => e.session_id === "sess-1")).toBe(true);
  });

  it("hash chain is valid after compaction", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    await journal.compact(["sess-1"]);
    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("index is correct after compaction", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    await journal.compact(["sess-1"]);
    expect(journal.getSessionEventCount("sess-1")).toBe(2);
    expect(journal.getSessionEventCount("sess-2")).toBe(0);

    const sess1 = await journal.readSession("sess-1");
    expect(sess1).toHaveLength(2);
  });

  it("compaction returns before/after counts", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});

    const result = await journal.compact(["sess-1"]);
    expect(result).toEqual({ before: 2, after: 1 });
  });

  it("index survives compaction", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    await journal.compact(["sess-1"]);

    // New emit after compaction should still be indexed
    await journal.emit("sess-1", "session.completed", {});
    expect(journal.getSessionEventCount("sess-1")).toBe(3);

    const events = await journal.readSession("sess-1");
    expect(events[2]!.type).toBe("session.completed");
  });

  it("compaction without retainSessionIds is a no-op (keeps all)", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});

    const result = await journal.compact();
    expect(result.before).toBe(2);
    expect(result.after).toBe(2);
  });

  it("seq numbers are rebuilt after compaction", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    await journal.compact(["sess-1"]);
    const events = await journal.readSession("sess-1");
    expect(events[0]!.seq).toBe(0);
    expect(events[1]!.seq).toBe(1);

    // Next emit should continue from seq 2
    const e = await journal.emit("sess-1", "session.completed", {});
    expect(e.seq).toBe(2);
  });

  // ─── Health Check Tests ───────────────────────────────────────────

  it("checkHealth returns writable for accessible journal", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    const health = await journal.checkHealth();
    expect(health.writable).toBe(true);
  });

  it("checkHealth returns not writable for nonexistent file", async () => {
    const journal = new Journal(resolve(TEST_DIR, "nonexistent-dir", "nope.jsonl"));
    // Don't init — file doesn't exist
    const health = await journal.checkHealth();
    expect(health.writable).toBe(false);
  });

  it("getFilePath returns the configured path", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    expect(journal.getFilePath()).toBe(TEST_FILE);
  });

  // ─── Redaction Tests ────────────────────────────────────────────────

  it("redacts sensitive payload fields on emit", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    const event = await journal.emit("sess-1", "session.created", {
      authorization: "Bearer secret-token-123",
      safe_field: "visible",
    });
    expect(event.payload.authorization).toBe("[REDACTED]");
    expect(event.payload.safe_field).toBe("visible");

    // Also verify it's stored redacted on disk
    const events = await journal.readAll();
    const stored = events.find((e) => e.event_id === event.event_id)!;
    expect(stored.payload.authorization).toBe("[REDACTED]");
  });

  it("preserves payload when redaction is disabled", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, redact: false });
    await journal.init();
    const event = await journal.emit("sess-1", "session.created", {
      authorization: "Bearer secret-token-123",
    });
    expect(event.payload.authorization).toBe("Bearer secret-token-123");
  });

  // ─── Fsync Option Tests ─────────────────────────────────────────────

  it("disabling fsync works for tests", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", { test: true });
    const events = await journal.readAll();
    expect(events).toHaveLength(1);
  });

  it("enabling fsync does not crash", async () => {
    const journal = new Journal(TEST_FILE, { fsync: true });
    await journal.init();
    await journal.emit("sess-1", "session.created", { test: true });
    const events = await journal.readAll();
    expect(events).toHaveLength(1);
  });

  // ─── tryEmit Tests ──────────────────────────────────────────────────

  it("tryEmit returns event on success", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    const event = await journal.tryEmit("sess-1", "session.created", { test: true });
    expect(event).not.toBeNull();
    expect(event!.type).toBe("session.created");
  });

  it("tryEmit returns null on failure", async () => {
    const journal = new Journal(resolve(TEST_DIR, "nonexistent-dir", "sub", "test.jsonl"), { fsync: false });
    // Don't init — directory doesn't exist, emit will fail
    const event = await journal.tryEmit("sess-1", "session.created", {});
    expect(event).toBeNull();
  });

  // ─── getDiskUsage Tests ─────────────────────────────────────────────

  it("getDiskUsage returns disk stats", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    const usage = await journal.getDiskUsage();
    expect(usage).not.toBeNull();
    expect(usage!.total_bytes).toBeGreaterThan(0);
    expect(usage!.available_bytes).toBeGreaterThan(0);
    expect(usage!.usage_pct).toBeGreaterThanOrEqual(0);
    expect(usage!.usage_pct).toBeLessThanOrEqual(100);
  });

  it("checkHealth includes disk_usage", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    const health = await journal.checkHealth();
    expect(health.writable).toBe(true);
    expect(health.disk_usage).toBeDefined();
    expect(health.disk_usage!.total_bytes).toBeGreaterThan(0);
  });

  // ─── close() Tests ─────────────────────────────────────────────────

  it("close() waits for pending writes to flush", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();

    // Fire multiple writes concurrently
    const writes = Array.from({ length: 10 }, (_, i) =>
      journal.emit(`sess-${i}`, "session.created", { step: i })
    );

    // Close should wait for all pending writes
    await journal.close();

    // All writes should have completed — await them to be sure
    await Promise.all(writes);

    // Verify all events were written
    const events = await journal.readAll();
    expect(events.length).toBe(10);
  });

  it("close() is safe to call multiple times", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});

    // Multiple close calls should not throw
    await journal.close();
    await journal.close();
    await journal.close();
  });

  it("close() resolves immediately when no writes pending", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false });
    await journal.init();

    // No writes — close should resolve instantly
    await journal.close();
  });
});
