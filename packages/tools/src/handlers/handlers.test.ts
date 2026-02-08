import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PolicyProfile } from "@jarvis/schemas";
import { readFileHandler } from "./read-file.js";
import { writeFileHandler } from "./write-file.js";
import { shellExecHandler } from "./shell-exec.js";
import { httpRequestHandler } from "./http-request.js";
import { PolicyViolationError } from "../policy-enforcer.js";

const openPolicy: PolicyProfile = {
  allowed_paths: [],
  allowed_endpoints: [],
  allowed_commands: [],
  require_approval_for_writes: false,
};

describe("readFileHandler", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads an existing file", async () => {
    const filePath = join(tmpDir, "test.txt");
    await writeFile(filePath, "hello world", "utf-8");
    const result = (await readFileHandler({ path: filePath }, "real", policy)) as any;
    expect(result.exists).toBe(true);
    expect(result.content).toBe("hello world");
    expect(result.size_bytes).toBeGreaterThan(0);
  });

  it("returns exists=false for missing file", async () => {
    const filePath = join(tmpDir, "missing.txt");
    const result = (await readFileHandler({ path: filePath }, "real", policy)) as any;
    expect(result.exists).toBe(false);
    expect(result.content).toBe("");
  });

  it("returns dry_run output without reading", async () => {
    const filePath = join(tmpDir, "test.txt");
    const result = (await readFileHandler({ path: filePath }, "dry_run", policy)) as any;
    expect(result.content).toContain("[dry_run]");
    expect(result.size_bytes).toBe(0);
  });

  it("rejects paths outside policy", async () => {
    const restrictedPolicy: PolicyProfile = { ...openPolicy, allowed_paths: ["/safe-only"] };
    await expect(
      readFileHandler({ path: "/etc/passwd" }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
  });
});

describe("writeFileHandler", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes content to a file", async () => {
    const filePath = join(tmpDir, "output.txt");
    const result = (await writeFileHandler(
      { path: filePath, content: "written content" }, "real", policy
    )) as any;
    expect(result.written).toBe(true);
    expect(result.bytes_written).toBe(Buffer.byteLength("written content", "utf-8"));
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("written content");
  });

  it("creates nested directories", async () => {
    const filePath = join(tmpDir, "sub", "dir", "file.txt");
    const result = (await writeFileHandler(
      { path: filePath, content: "nested" }, "real", policy
    )) as any;
    expect(result.written).toBe(true);
    expect(existsSync(filePath)).toBe(true);
  });

  it("returns dry_run output without writing", async () => {
    const filePath = join(tmpDir, "dry.txt");
    const result = (await writeFileHandler(
      { path: filePath, content: "should not write" }, "dry_run", policy
    )) as any;
    expect(result.written).toBe(false);
    expect(result.bytes_written).toBeGreaterThan(0);
    expect(existsSync(filePath)).toBe(false);
  });

  it("rejects paths outside policy", async () => {
    const restrictedPolicy: PolicyProfile = { ...openPolicy, allowed_paths: ["/safe-only"] };
    await expect(
      writeFileHandler({ path: "/tmp/evil.txt", content: "bad" }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
  });
});

describe("shellExecHandler", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("executes a command and returns output", async () => {
    const result = (await shellExecHandler(
      { command: "echo hello", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exit_code).toBe(0);
  });

  it("returns dry_run output without executing", async () => {
    const result = (await shellExecHandler(
      { command: "echo hello", cwd: tmpDir }, "dry_run", policy
    )) as any;
    expect(result.stdout).toContain("[dry_run]");
    expect(result.exit_code).toBe(0);
  });

  it("rejects commands not in allowlist", async () => {
    const restrictedPolicy: PolicyProfile = {
      ...openPolicy,
      allowed_paths: [tmpDir],
      allowed_commands: ["ls"],
    };
    await expect(
      shellExecHandler({ command: "rm -rf /" }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
  });

  it("rejects cwd outside policy paths", async () => {
    const restrictedPolicy: PolicyProfile = { ...openPolicy, allowed_paths: ["/safe-only"] };
    await expect(
      shellExecHandler({ command: "echo hi", cwd: "/tmp" }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
  });

  it("allows commands in the allowlist", async () => {
    const restrictedPolicy: PolicyProfile = {
      ...openPolicy,
      allowed_paths: [tmpDir],
      allowed_commands: ["echo"],
    };
    const result = (await shellExecHandler(
      { command: "echo allowed", cwd: tmpDir }, "real", restrictedPolicy
    )) as any;
    expect(result.stdout.trim()).toBe("allowed");
  });

  it("handles command failure", async () => {
    const result = (await shellExecHandler(
      { command: "false", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.exit_code).not.toBe(0);
  });
});

describe("shellExecHandler environment sanitization", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("filters out AWS_SECRET_ACCESS_KEY from environment", async () => {
    const originalValue = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key-123";
    try {
      const result = (await shellExecHandler(
        { command: "env", cwd: tmpDir }, "real", policy
      )) as any;
      expect(result.stdout).not.toContain("AWS_SECRET_ACCESS_KEY");
    } finally {
      if (originalValue !== undefined) process.env.AWS_SECRET_ACCESS_KEY = originalValue;
      else delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it("filters out GITHUB_TOKEN from environment", async () => {
    const originalValue = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_test123";
    try {
      const result = (await shellExecHandler(
        { command: "env", cwd: tmpDir }, "real", policy
      )) as any;
      expect(result.stdout).not.toContain("GITHUB_TOKEN");
    } finally {
      if (originalValue !== undefined) process.env.GITHUB_TOKEN = originalValue;
      else delete process.env.GITHUB_TOKEN;
    }
  });

  it("preserves PATH in environment", async () => {
    const result = (await shellExecHandler(
      { command: "env", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout).toContain("PATH=");
  });
});

describe("readFileHandler — file size cap", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects files exceeding 10 MB size cap", async () => {
    const filePath = join(tmpDir, "huge.txt");
    // Create a file slightly over 10 MB by writing a sparse descriptor
    // We use stat-based check, so just need the file to report > 10MB
    const tenMBPlus = Buffer.alloc(10 * 1024 * 1024 + 1, "a");
    await writeFile(filePath, tenMBPlus);
    await expect(
      readFileHandler({ path: filePath }, "real", policy)
    ).rejects.toThrow(/exceeding the .* byte limit/);
  });

  it("reads files at exactly the 10 MB limit", async () => {
    const filePath = join(tmpDir, "exact.txt");
    const exactTenMB = Buffer.alloc(10 * 1024 * 1024, "b");
    await writeFile(filePath, exactTenMB);
    const result = (await readFileHandler({ path: filePath }, "real", policy)) as any;
    expect(result.exists).toBe(true);
    expect(result.size_bytes).toBe(10 * 1024 * 1024);
  });
});

describe("shellExecHandler — timeout configuration", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts custom timeout_ms", async () => {
    const result = (await shellExecHandler(
      { command: "echo timeout_test", cwd: tmpDir, timeout_ms: 5000 }, "real", policy
    )) as any;
    expect(result.stdout.trim()).toBe("timeout_test");
    expect(result.exit_code).toBe(0);
  });

  it("clamps timeout_ms to maximum of 300000ms", async () => {
    // Should not throw — the timeout is clamped, not rejected
    const result = (await shellExecHandler(
      { command: "echo hi", cwd: tmpDir, timeout_ms: 999999 }, "real", policy
    )) as any;
    expect(result.exit_code).toBe(0);
  });

  it("clamps timeout_ms to minimum of 1000ms", async () => {
    const result = (await shellExecHandler(
      { command: "echo hi", cwd: tmpDir, timeout_ms: 100 }, "real", policy
    )) as any;
    expect(result.exit_code).toBe(0);
  });

  it("uses default timeout when timeout_ms not provided", async () => {
    const result = (await shellExecHandler(
      { command: "echo default", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.exit_code).toBe(0);
  });
});

describe("shellExecHandler — JARVIS_ env prefix filtering", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("filters out JARVIS_ prefixed environment variables", async () => {
    const original = process.env.JARVIS_API_TOKEN;
    process.env.JARVIS_API_TOKEN = "secret-token-123";
    try {
      const result = (await shellExecHandler(
        { command: "env", cwd: tmpDir }, "real", policy
      )) as any;
      expect(result.stdout).not.toContain("JARVIS_API_TOKEN");
    } finally {
      if (original !== undefined) process.env.JARVIS_API_TOKEN = original;
      else delete process.env.JARVIS_API_TOKEN;
    }
  });

  it("filters out DATABASE_URL environment variable", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://user:pass@host/db";
    try {
      const result = (await shellExecHandler(
        { command: "env", cwd: tmpDir }, "real", policy
      )) as any;
      expect(result.stdout).not.toContain("DATABASE_URL");
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
      else delete process.env.DATABASE_URL;
    }
  });

  it("filters out variables ending with _SECRET", async () => {
    const original = process.env.MY_APP_SECRET;
    process.env.MY_APP_SECRET = "supersecret";
    try {
      const result = (await shellExecHandler(
        { command: "env", cwd: tmpDir }, "real", policy
      )) as any;
      expect(result.stdout).not.toContain("MY_APP_SECRET");
    } finally {
      if (original !== undefined) process.env.MY_APP_SECRET = original;
      else delete process.env.MY_APP_SECRET;
    }
  });
});

describe("httpRequestHandler", () => {
  it("returns dry_run output without fetching", async () => {
    const result = (await httpRequestHandler(
      { url: "https://example.com", method: "GET" }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
    expect(result.status).toBe(0);
  });

  it("rejects endpoints not in allowlist", async () => {
    const restrictedPolicy: PolicyProfile = {
      ...openPolicy,
      allowed_endpoints: ["https://api.allowed.com"],
    };
    await expect(
      httpRequestHandler(
        { url: "https://evil.com/steal", method: "GET" }, "real", restrictedPolicy
      )
    ).rejects.toThrow(PolicyViolationError);
  });

  it("allows endpoints in allowlist (dry_run to avoid network)", async () => {
    const policy: PolicyProfile = {
      ...openPolicy,
      allowed_endpoints: ["https://api.allowed.com"],
    };
    const result = (await httpRequestHandler(
      { url: "https://api.allowed.com/data", method: "GET" }, "dry_run", policy
    )) as any;
    expect(result.body).toContain("[dry_run]");
  });
});
