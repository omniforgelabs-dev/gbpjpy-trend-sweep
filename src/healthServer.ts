/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MINIMAL HTTP HEALTH ENDPOINT (Render Free Web Service Support)
 * ═══════════════════════════════════════════════════════════════════════════
 * Lightweight HTTP server using Node.js built-in 'http' module (zero extra dependencies).
 *
 * SPECIFICATION CONFORMANCE:
 * 1. Returns HTTP 200 and a compact JSON status confirming application is running.
 * 2. Does NOT execute trades, modify positions, or alter trading strategy logic.
 * 3. Runs asynchronously alongside the GBP/JPY trading loop in the same process.
 * 4. Listens on 0.0.0.0 using Render's PORT environment variable (default: 10000).
 * 5. Does NOT interfere with trading loops or spawn duplicate bot instances.
 * 6. Supports graceful server shutdown during process termination.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http";

export interface BotHealthStatus {
  status: "healthy" | "starting" | "stopped";
  service: string;
  pair: string;
  mode: "demo" | "live";
  executionEngine: string;
  confluenceMode?: boolean;
  uptimeSeconds: number;
  activeTrade: boolean;
  activeTradeId: string | null;
  lastHeartbeat: string;
  lastScanCheck?: string;
  lastScanRegime?: string;
  lastScanScore?: number;
  resolvedAccessPoint?: string | null;
  timestamp: string;
}

export interface HealthStatusProvider {
  getHealthStatus(): BotHealthStatus;
}

/**
 * Starts the lightweight HTTP health server.
 *
 * @param port Port to listen on (typically process.env.PORT or 10000)
 * @param provider Optional bot status provider for live telemetry
 */
export function startHealthServer(
  port: number | string = process.env.PORT || 10000,
  provider?: HealthStatusProvider
): http.Server {
  const listenPort = typeof port === "string" ? parseInt(port, 10) : port;

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawPath = (req.url || "").split("?")[0];
    const normalizedPath = rawPath.replace(/\/+$/, "") || "/";

    // 1. Health check routes: /health, /healthz, or root /
    if (normalizedPath === "/health" || normalizedPath === "/healthz" || normalizedPath === "/") {
      const data: BotHealthStatus = provider
        ? provider.getHealthStatus()
        : {
            status: "healthy",
            service: "gbpjpy-trend-sweep",
            pair: "GBP/JPY",
            mode: "demo",
            executionEngine: "simulation",
            uptimeSeconds: Math.floor(process.uptime()),
            activeTrade: false,
            activeTradeId: null,
            lastHeartbeat: new Date().toISOString(),
            timestamp: new Date().toISOString(),
          };

      const payload = JSON.stringify(data, null, 2);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(payload);
      return;
    }

    // 2. All other routes return 404
    const notFoundPayload = JSON.stringify(
      {
        error: "Not Found",
        message: "GBP/JPY Trend Sweep Bot is running. Health check available at /health",
      },
      null,
      2
    );

    res.writeHead(404, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(notFoundPayload),
    });
    res.end(notFoundPayload);
  });

  server.listen(listenPort, "0.0.0.0", () => {
    console.log(`[HEALTH] Web Service health endpoint active: http://0.0.0.0:${listenPort}/health`);
  });

  return server;
}
