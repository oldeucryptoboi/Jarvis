import { tmpdir } from "node:os";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import type { PluginManifest, PluginApi } from "@karnevil9/schemas";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry } from "@karnevil9/tools";
import { PluginApiImpl } from "./plugin-api-impl.js";
import { PluginLoggerImpl } from "./plugin-logger.js";
import { HookRunner } from "./hook-runner.js";

export class PluginTestHarness {
  static async create(
    manifest: PluginManifest,
    config?: Record<string, unknown>
  ): Promise<{
    api: PluginApi;
    hookRunner: HookRunner;
    toolRegistry: ToolRegistry;
    journal: Journal;
  }> {
    const journalPath = join(tmpdir(), `karnevil9-test-${uuid()}.jsonl`);
    const journal = new Journal(journalPath, { fsync: false, redact: false });
    await journal.init();

    const toolRegistry = new ToolRegistry();
    const hookRunner = new HookRunner(journal);
    const logger = new PluginLoggerImpl(manifest.id);
    const api = new PluginApiImpl(manifest, config ?? {}, logger);

    return { api, hookRunner, toolRegistry, journal };
  }
}
