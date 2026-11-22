/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST SUITE: GBP/JPY DYNAMIC POSITION SIZER & RISK RULES
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { calculateGbpJpyPositionSize } from "../src/risk/positionSizer.js";

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

console.log("\n=== Position Sizer & Risk Management Test Suite ===");

// 1. Standard $10 Account with 0.001 Lot Support
{
  const res = calculateGbpJpyPositionSize({
    entryPrice: 208.50,
    slPrice: 208.20, // 30 pips stop
    tp1Price: 208.80, // 30 pips TP1 (1.00R)
    accountBalance: 10.0,
    liveUsdJpyRate: 155.0,
    maxIntendedRiskUsd: 1.00,
    spec: {
      contractSize: 100000,
      volumeMin: 0.001,
      volumeStep: 0.001,
    },
  });

  assert(res.stopPips === 30, `1a. Stop distance correctly computed as 30 pips (got ${res.stopPips})`);
  assert(res.pipValuePerLotUsd > 6.0 && res.pipValuePerLotUsd < 7.0, `1b. JPY pip value per standard lot ~$6.45 (got ${res.pipValuePerLotUsd})`);
  assert(res.actualEstimatedRiskUsd <= 1.00, `1c. Actual risk respects <= $1.00 ceiling (got $${res.actualEstimatedRiskUsd})`);
  assert(res.permittedVolume >= 0.001, `1d. Permitted volume is at least 0.001 lots (got ${res.permittedVolume})`);
  assert(res.rewardToRiskRatio === 1.0, `1e. Standard R:R is 1.00 (got ${res.rewardToRiskRatio})`);
  assert(!res.isScaledDown, "1f. Standard R:R setup is not scaled down");
}

// 2. Proportional Risk Reduction for Lower R:R Setups (Does NOT Reject Trade!)
{
  const res = calculateGbpJpyPositionSize({
    entryPrice: 208.50,
    slPrice: 208.10, // 40 pips stop
    tp1Price: 208.75, // 25 pips TP1 (R:R = 25/40 = 0.625)
    accountBalance: 10.0,
    liveUsdJpyRate: 155.0,
    maxIntendedRiskUsd: 1.00,
    spec: {
      contractSize: 100000,
      volumeMin: 0.001,
      volumeStep: 0.001,
    },
  });

  assert(res.rewardToRiskRatio < 1.0, `2a. Detected lower R:R (${res.rewardToRiskRatio})`);
  assert(res.isScaledDown === true, "2b. Setup was scaled down in dollar risk rather than rejected");
  assert(res.targetRiskUsd < 1.00, `2c. Target risk reduced proportionally (target: $${res.targetRiskUsd})`);
  assert(res.permittedVolume > 0, "2d. Permitted volume calculated and non-zero");
}

// 3. Broker with Standard 0.01 Minimum Lot
{
  const res = calculateGbpJpyPositionSize({
    entryPrice: 208.50,
    slPrice: 208.35, // 15 pips stop
    tp1Price: 208.80, // 30 pips TP1
    accountBalance: 10.0,
    liveUsdJpyRate: 155.0,
    maxIntendedRiskUsd: 1.00,
    spec: {
      contractSize: 100000,
      volumeMin: 0.01,
      volumeStep: 0.01,
    },
  });

  assert(res.permittedVolume >= 0.01, `3a. Permitted volume respects broker volumeMin 0.01 (got ${res.permittedVolume})`);
  assert(res.notes.length > 0, "3b. Risk diagnostic notes provided");
}

// 4. Strict Non-Modification of Entry and Stop-Loss Prices
{
  const entry = 208.455;
  const sl = 208.125;
  const res = calculateGbpJpyPositionSize({
    entryPrice: entry,
    slPrice: sl,
    tp1Price: 208.855,
    accountBalance: 10.0,
    liveUsdJpyRate: 155.0,
    maxIntendedRiskUsd: 1.00,
  });

  const expectedStopDist = Number(Math.abs(entry - sl).toFixed(3));
  assert(res.stopDistance === expectedStopDist, `4a. Stop distance is strictly preserved (expected ${expectedStopDist}, got ${res.stopDistance})`);
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
