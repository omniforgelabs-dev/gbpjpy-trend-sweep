/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST SUITE: MINIMAL HTTP HEALTH ENDPOINT (Render Free Web Service)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { startHealthServer, HealthStatusProvider, BotHealthStatus } from "../src/healthServer.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}`);
    failed++;
  }
}

console.log("\n=== HTTP Health Server Test Suite ===");

async function runTests() {
  const mockProvider: HealthStatusProvider = {
    getHealthStatus(): BotHealthStatus {
      return {
        status: "healthy",
        service: "gbpjpy-trend-sweep",
        pair: "GBP/JPY",
        mode: "demo",
        executionEngine: "simulation",
        uptimeSeconds: 42,
        activeTrade: false,
        activeTradeId: null,
        lastHeartbeat: "2026-11-22T10:00:00.000Z",
        timestamp: new Date().toISOString(),
      };
    },
  };

  const testPort = 11432;
  const server = startHealthServer(testPort, mockProvider);

  try {
    // 1. Test /health endpoint
    const resHealth = await fetch(`http://127.0.0.1:${testPort}/health`);
    assert(resHealth.status === 200, `1a. /health returns HTTP 200 (got ${resHealth.status})`);
    const dataHealth: any = await resHealth.json();
    assert(dataHealth.status === "healthy", `1b. Health status is 'healthy' (got ${dataHealth.status})`);
    assert(dataHealth.pair === "GBP/JPY", `1c. Dedicated pair is GBP/JPY (got ${dataHealth.pair})`);
    assert(dataHealth.service === "gbpjpy-trend-sweep", `1d. Service name matches (got ${dataHealth.service})`);

    // 2. Test root / endpoint
    const resRoot = await fetch(`http://127.0.0.1:${testPort}/`);
    assert(resRoot.status === 200, `2a. / returns HTTP 200 (got ${resRoot.status})`);

    // 3. Test /healthz endpoint (Kubernetes / Render alias)
    const resHealthz = await fetch(`http://127.0.0.1:${testPort}/healthz`);
    assert(resHealthz.status === 200, `3a. /healthz returns HTTP 200 (got ${resHealthz.status})`);

    // 4. Test 404 on unhandled routes
    const resNotFound = await fetch(`http://127.0.0.1:${testPort}/unknown-route`);
    assert(resNotFound.status === 404, `4a. Unhandled route returns HTTP 404 (got ${resNotFound.status})`);
    const dataNotFound: any = await resNotFound.json();
    assert(dataNotFound.error === "Not Found", "4b. 404 response contains JSON error message");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    assert(true, "5a. Health server closed gracefully");
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Test runner exception:", err);
  process.exit(1);
});
