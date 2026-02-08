import { describe, it, expect } from "vitest";
import { redactPayload } from "./redact.js";

describe("redactPayload", () => {
  it("redacts authorization key", () => {
    const result = redactPayload({ authorization: "Bearer abc123" });
    expect(result).toEqual({ authorization: "[REDACTED]" });
  });

  it("redacts password key", () => {
    const result = redactPayload({ password: "s3cret" });
    expect(result).toEqual({ password: "[REDACTED]" });
  });

  it("redacts secret key", () => {
    const result = redactPayload({ secret: "my-secret" });
    expect(result).toEqual({ secret: "[REDACTED]" });
  });

  it("redacts token key", () => {
    const result = redactPayload({ token: "abc" });
    expect(result).toEqual({ token: "[REDACTED]" });
  });

  it("redacts api_key key", () => {
    const result = redactPayload({ api_key: "key-123" });
    expect(result).toEqual({ api_key: "[REDACTED]" });
  });

  it("redacts apikey key (case-insensitive)", () => {
    const result = redactPayload({ ApiKey: "key-123" });
    expect(result).toEqual({ ApiKey: "[REDACTED]" });
  });

  it("redacts api-key key", () => {
    const result = redactPayload({ "api-key": "key-123" });
    expect(result).toEqual({ "api-key": "[REDACTED]" });
  });

  it("redacts credential key", () => {
    const result = redactPayload({ credential: "creds" });
    expect(result).toEqual({ credential: "[REDACTED]" });
  });

  it("redacts private_key key", () => {
    const result = redactPayload({ private_key: "-----BEGIN RSA-----" });
    expect(result).toEqual({ private_key: "[REDACTED]" });
  });

  it("redacts values matching Bearer pattern", () => {
    const result = redactPayload({ header: "Bearer eyJhbGc..." });
    expect(result).toEqual({ header: "[REDACTED]" });
  });

  it("redacts values matching ghp_ pattern", () => {
    const result = redactPayload({ value: "ghp_abc123def456" });
    expect(result).toEqual({ value: "[REDACTED]" });
  });

  it("redacts values matching sk- pattern", () => {
    const result = redactPayload({ key: "sk-abc123" });
    expect(result).toEqual({ key: "[REDACTED]" });
  });

  it("redacts values matching AKIA pattern", () => {
    const result = redactPayload({ aws: "AKIAIOSFODNN7EXAMPLE" });
    expect(result).toEqual({ aws: "[REDACTED]" });
  });

  it("redacts values matching xoxb- Slack token pattern", () => {
    const result = redactPayload({ slack: "xoxb-123456789" });
    expect(result).toEqual({ slack: "[REDACTED]" });
  });

  it("preserves non-sensitive data", () => {
    const result = redactPayload({ name: "John", count: 42 });
    expect(result).toEqual({ name: "John", count: 42 });
  });

  it("handles nested objects", () => {
    const result = redactPayload({
      outer: { authorization: "Bearer abc", safe: "value" },
    });
    expect(result).toEqual({
      outer: { authorization: "[REDACTED]", safe: "value" },
    });
  });

  it("handles arrays", () => {
    const result = redactPayload([
      { token: "abc" },
      { safe: "value" },
    ]);
    expect(result).toEqual([
      { token: "[REDACTED]" },
      { safe: "value" },
    ]);
  });

  it("handles null", () => {
    expect(redactPayload(null)).toBeNull();
  });

  it("handles undefined", () => {
    expect(redactPayload(undefined)).toBeUndefined();
  });

  it("handles primitives", () => {
    expect(redactPayload(42)).toBe(42);
    expect(redactPayload("safe string")).toBe("safe string");
    expect(redactPayload(true)).toBe(true);
  });

  it("redacts sensitive string values at top level of array", () => {
    const result = redactPayload(["safe", "Bearer abc123", "also safe"]);
    expect(result).toEqual(["safe", "[REDACTED]", "also safe"]);
  });

  // ─── Expanded patterns: Stripe, Twilio, SendGrid, Supabase, DB URIs ─────

  it("redacts Stripe live secret keys (sk_live_)", () => {
    expect(redactPayload({ key: "sk_live_abc123def456" })).toEqual({ key: "[REDACTED]" });
  });

  it("redacts Stripe test secret keys (sk_test_)", () => {
    expect(redactPayload({ key: "sk_test_abc123def456" })).toEqual({ key: "[REDACTED]" });
  });

  it("redacts Stripe restricted keys (rk_live_, rk_test_)", () => {
    expect(redactPayload({ a: "rk_live_abc", b: "rk_test_xyz" }))
      .toEqual({ a: "[REDACTED]", b: "[REDACTED]" });
  });

  it("redacts Stripe publishable keys (pk_live_, pk_test_)", () => {
    expect(redactPayload({ a: "pk_live_abc", b: "pk_test_xyz" }))
      .toEqual({ a: "[REDACTED]", b: "[REDACTED]" });
  });

  it("redacts Stripe webhook secrets (whsec_)", () => {
    expect(redactPayload({ wh: "whsec_abc123def456ghi789" })).toEqual({ wh: "[REDACTED]" });
  });

  it("redacts Supabase project keys (sbp_ followed by 40 chars)", () => {
    expect(redactPayload({ key: "sbp_" + "a".repeat(40) })).toEqual({ key: "[REDACTED]" });
  });

  it("redacts SendGrid API keys (SG. pattern)", () => {
    expect(redactPayload({ key: "SG." + "a".repeat(22) + ".more" })).toEqual({ key: "[REDACTED]" });
  });

  it("redacts Twilio Account SIDs (AC followed by 32 hex chars)", () => {
    expect(redactPayload({ sid: "AC" + "a".repeat(32) })).toEqual({ sid: "[REDACTED]" });
  });

  it("redacts Twilio Auth Tokens (sk followed by 32 hex chars)", () => {
    expect(redactPayload({ token: "sk" + "a".repeat(32) })).toEqual({ token: "[REDACTED]" });
  });

  it("redacts PostgreSQL connection strings", () => {
    expect(redactPayload({ url: "postgres://user:pass@host:5432/db" })).toEqual({ url: "[REDACTED]" });
    expect(redactPayload({ url: "postgresql://user:pass@host/db" })).toEqual({ url: "[REDACTED]" });
  });

  it("redacts MongoDB connection strings", () => {
    expect(redactPayload({ url: "mongodb://user:pass@host:27017/db" })).toEqual({ url: "[REDACTED]" });
    expect(redactPayload({ url: "mongodb+srv://user:pass@cluster.example.com/db" })).toEqual({ url: "[REDACTED]" });
  });

  it("redacts MySQL connection strings", () => {
    expect(redactPayload({ url: "mysql://user:pass@host:3306/db" })).toEqual({ url: "[REDACTED]" });
  });

  it("redacts Redis connection strings", () => {
    expect(redactPayload({ url: "redis://user:pass@host:6379/0" })).toEqual({ url: "[REDACTED]" });
  });

  it("redacts Google API keys (AIza pattern)", () => {
    expect(redactPayload({ key: "AIza" + "a".repeat(35) })).toEqual({ key: "[REDACTED]" });
  });

  it("redacts Google OAuth tokens (ya29. pattern)", () => {
    expect(redactPayload({ token: "ya29.some-long-oauth-token" })).toEqual({ token: "[REDACTED]" });
  });

  it("redacts GitHub fine-grained PATs (github_pat_)", () => {
    expect(redactPayload({ pat: "github_pat_abc123def456" })).toEqual({ pat: "[REDACTED]" });
  });

  it("redacts GitHub OAuth tokens (gho_)", () => {
    expect(redactPayload({ tok: "gho_abc123def456" })).toEqual({ tok: "[REDACTED]" });
  });

  it("redacts Anthropic API keys (sk-ant-)", () => {
    expect(redactPayload({ key: "sk-ant-abc123def456" })).toEqual({ key: "[REDACTED]" });
  });

  it("redacts OpenAI project keys (sk-proj-)", () => {
    expect(redactPayload({ key: "sk-proj-abc123def456" })).toEqual({ key: "[REDACTED]" });
  });

  it("redacts JWT tokens (eyJ pattern)", () => {
    expect(redactPayload({ jwt: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig" })).toEqual({ jwt: "[REDACTED]" });
  });

  it("redacts PEM private keys", () => {
    expect(redactPayload({ key: "-----BEGIN PRIVATE KEY-----\nMIIEvQ..." })).toEqual({ key: "[REDACTED]" });
    expect(redactPayload({ key: "-----BEGIN RSA PRIVATE KEY-----\nMIIBog..." })).toEqual({ key: "[REDACTED]" });
  });

  it("redacts keys named connection_string and database_url", () => {
    expect(redactPayload({ connection_string: "Server=myServer;Database=myDB;User Id=myUser;Password=myPass;" }))
      .toEqual({ connection_string: "[REDACTED]" });
    expect(redactPayload({ database_url: "postgres://u:p@h/d" }))
      .toEqual({ database_url: "[REDACTED]" });
  });

  it("redacts keys named access_token and refresh_token", () => {
    expect(redactPayload({ access_token: "eyJxyz", refresh_token: "rft_abc" }))
      .toEqual({ access_token: "[REDACTED]", refresh_token: "[REDACTED]" });
  });

  it("redacts keys named client_secret", () => {
    expect(redactPayload({ client_secret: "my-secret-value" }))
      .toEqual({ client_secret: "[REDACTED]" });
  });
});
