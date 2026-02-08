import type { MetricsCollector } from "./metrics-collector.js";

export interface MetricsRouter {
  method: string;
  path: string;
  handler: (
    req: { method: string; path: string; params: Record<string, string>; query: Record<string, string>; body: unknown },
    res: {
      json(data: unknown): void;
      text(data: string, contentType?: string): void;
      status(code: number): { json(data: unknown): void; text(data: string, contentType?: string): void };
    }
  ) => Promise<void>;
}

export function createMetricsRouter(collector: MetricsCollector): MetricsRouter {
  return {
    method: "GET",
    path: "/metrics",
    handler: async (_req, res) => {
      try {
        const metrics = await collector.getMetrics();
        res.text(metrics, collector.getContentType());
      } catch {
        res.status(500).text("# Error collecting metrics\n", "text/plain; charset=utf-8");
      }
    },
  };
}
