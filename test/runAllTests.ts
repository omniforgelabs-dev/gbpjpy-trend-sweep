/**
 * Unified Test Runner for all GBP/JPY Trend Sweep test suites.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const suites = [
  "test/trendSweep.test.ts",
  "test/positionSizer.test.ts",
  "test/exnessClient.test.ts",
  "test/botIntegration.test.ts",
  "test/healthServer.test.ts",
];

let totalPassed = true;

console.log("═══════════════════════════════════════════════════════════════");
console.log("  RUNNING ALL GBP/JPY TREND SWEEP VERIFICATION SUITES");
console.log("═══════════════════════════════════════════════════════════════");

for (const suite of suites) {
  const fullPath = path.join(process.cwd(), suite);
  console.log(`\n▶ Running ${suite}...`);
  const res = spawnSync("npx", ["tsx", fullPath], { stdio: "inherit", shell: true });
  if (res.status !== 0) {
    totalPassed = false;
    console.error(`❌ Suite ${suite} failed with exit code ${res.status}`);
  }
}

if (!totalPassed) {
  console.error("\n❌ Some test suites failed!");
  process.exit(1);
} else {
  console.log("\n✅ ALL GBP/JPY TREND SWEEP SUITES PASSED SUCCESSFULLY!\n");
}
