/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST SUITE: GBP/JPY TREND SWEEP STRATEGY ENGINE
 * ═══════════════════════════════════════════════════════════════════════════
 */

import fs from "node:fs";
import path from "node:path";
import {
  evaluateGbpJpyTrendSweep,
  computeAtr,
  computeEma,
  findCompletedH1Index,
  Candle,
} from "../src/strategy/trendSweep.js";

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

console.log("\n=== Trend Sweep Strategy Test Suite ===");

// 1. Math Functions
{
  const series = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const ema = computeEma(series, 5);
  assert(ema.length === series.length, "1a. EMA output length matches input");
  assert(ema[4] === 12, `1b. Initial SMA at index 4 is 12 (got ${ema[4]})`);
  assert(ema[9] > 16.5, `1c. Final EMA reflects upward trend (got ${ema[9].toFixed(2)})`);
}

// 2. Zero-Lookahead Completed H1 Bar Indexing
{
  const h1Candles: Candle[] = [
    { open: 200, high: 201, low: 199, close: 200.5, time: "2026-09-10T10:00:00Z" }, // 0
    { open: 200.5, high: 201.2, low: 200, close: 201.0, time: "2026-09-10T11:00:00Z" }, // 1
    { open: 201.0, high: 202.0, low: 200.8, close: 201.8, time: "2026-09-10T12:00:00Z" }, // 2
    { open: 201.8, high: 202.5, low: 201.5, close: 202.2, time: "2026-09-10T13:00:00Z" }, // 3
  ];

  // At 13:15 UTC, the 13:00 bar is still forming! Last COMPLETED bar started at 12:00 UTC (index 2)
  const tM15_1 = new Date("2026-09-10T13:15:00Z").getTime() / 1000;
  const idx1 = findCompletedH1Index(h1Candles, tM15_1);
  assert(idx1 === 2, `2a. Strictly identifies 12:00 bar (index 2) at 13:15 UTC (got ${idx1})`);

  // At 14:00 UTC, the 13:00 bar is fully completed (index 3)
  const tM15_2 = new Date("2026-09-10T14:00:00Z").getTime() / 1000;
  const idx2 = findCompletedH1Index(h1Candles, tM15_2);
  assert(idx2 === 3, `2b. Identifies 13:00 bar (index 3) as completed at 14:00 UTC (got ${idx2})`);
}

// 3. Setup Detection Logic (Synthetic BUY Sweep & Rejection)
{
  // 30 H1 bars with strong bullish trend (EMA10 > EMA20, close > EMA10)
  const h1Bars: Candle[] = [];
  for (let i = 0; i < 30; i++) {
    const p = 200.0 + i * 0.10;
    const hour = i % 24;
    h1Bars.push({
      open: p,
      high: p + 0.15,
      low: p - 0.05,
      close: p + 0.12,
      time: `2026-09-09T${String(hour).padStart(2, "0")}:00:00Z`,
    });
  }

  // 35 M15 bars in active session (Thursday 2026-09-10, 08:00 to 14:45 UTC)
  const m15Bars: Candle[] = [];
  for (let i = 0; i < 35; i++) {
    const totalMinutes = i * 15;
    const hour = 8 + Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const p = 203.0 + (i < 20 ? i * 0.05 : 1.0);
    m15Bars.push({
      open: p,
      high: p + 0.10,
      low: p - 0.05,
      close: p + 0.05,
      time: `2026-09-10T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
    });
  }

  // Bar 34 sweeps prior 20-bar low (from index 14 to 33) and closes bullish back inside with strong body
  const priorLow = Math.min(...m15Bars.slice(14, 34).map((b) => b.low));
  m15Bars[34] = {
    open: priorLow - 0.03,
    high: priorLow + 0.25,
    low: priorLow - 0.12, // Sweeps low!
    close: priorLow + 0.20, // Closes strongly back above!
    time: "2026-09-10T14:15:00Z",
  };

  const result = evaluateGbpJpyTrendSweep(m15Bars, h1Bars, 34);
  assert(result.macroRegime === "BUY", `3a. Macro H1 trend recognized as BUY (got ${result.macroRegime})`);
  assert(result.passed === true, "3b. BUY liquidity sweep setup passed");
  assert(result.setup?.direction === "BUY", `3c. Direction is BUY (got ${result.setup?.direction})`);
  assert(result.setup?.sl !== undefined && result.setup.sl < result.setup.entry, "3d. Stop loss is strictly below entry");
  assert(result.setup?.tp1 !== undefined && result.setup.tp1 > result.setup.entry, "3e. Target 1 is above entry");
  assert(result.setup?.tp2 !== undefined && result.setup.tp2 > result.setup.tp1, "3f. Target 2 runner is above Target 1");
}

// 4. Session Filter (Weekend & Off-hours rejection)
{
  const h1Bars: Candle[] = [];
  for (let i = 0; i < 30; i++) {
    h1Bars.push({
      open: 200,
      high: 201,
      low: 199,
      close: 200.5,
      time: `2026-09-11T${String(i % 24).padStart(2, "0")}:00:00Z`,
    });
  }
  const m15Bars: Candle[] = [];
  for (let i = 0; i < 35; i++) {
    m15Bars.push({
      open: 200,
      high: 201,
      low: 199,
      close: 200.5,
      time: "2026-09-12T10:00:00Z", // Saturday!
    });
  }

  const res = evaluateGbpJpyTrendSweep(m15Bars, h1Bars);
  assert(!res.passed, "4a. Weekend setup correctly rejected");
  assert(res.checks.some((c) => c.includes("Weekend")), "4b. Reason indicates weekend rejection");
}

// 5. Historical Data Replay Verification (from smc_backtest_kit archive)
{
  const m15Path = path.join(process.cwd(), "test", "data", "GBPJPY_M15.json");
  const h1Path = path.join(process.cwd(), "test", "data", "GBPJPY_H1.json");

  if (fs.existsSync(m15Path) && fs.existsSync(h1Path)) {
    const rawM15: any[] = JSON.parse(fs.readFileSync(m15Path, "utf-8"));
    const rawH1: any[] = JSON.parse(fs.readFileSync(h1Path, "utf-8"));

    const m15Candles: Candle[] = rawM15.map((b) => ({
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      time: b.t,
    }));
    const h1Candles: Candle[] = rawH1.map((b) => ({
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      time: b.t,
    }));

    let foundSetups = 0;
    // Scan across the first 1,000 M15 bars (~2 weeks of market action)
    for (let i = 50; i < Math.min(m15Candles.length, 1000); i++) {
      const subM15 = m15Candles.slice(0, i + 1);
      const res = evaluateGbpJpyTrendSweep(subM15, h1Candles, i);
      if (res.passed && res.setup) {
        foundSetups++;
      }
    }

    assert(foundSetups > 0, `5a. Replay on authentic historical GBP/JPY data found valid setups (${foundSetups} found)`);
  }
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
