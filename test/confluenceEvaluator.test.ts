/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GBP/JPY CONFLUENCE ENGINE VERIFICATION SUITE
 * ═══════════════════════════════════════════════════════════════════════════
 * Tests the 100-Point Institutional Confluence Scoring Engine:
 * 1. Historical Nov 23 09:10 UTC APEX GBP/JPY SELL trade replication
 * 2. Pure Trend Sweep priority (Grade A / A+)
 * 3. Kill-Zone Liquidity Sweep Synthesizer (London & NY Kill Zones)
 * 4. Outside Kill-Zone gate
 * 5. Structural TP1 anchoring
 * 6. Confluence toggle: pure vs confluence mode
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { evaluateGbpJpyConfluence } from "../src/strategy/confluenceEvaluator.js";
import { Candle } from "../src/strategy/trendSweep.js";

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log(`  PASS  ${msg}`);
}

async function runConfluenceTests() {
  console.log("\n=== GBP/JPY Confluence Engine Test Suite ===");

  // 1. Build synthetic historical market data matching Nov 23 09:10 UTC
  // 50 M15 bars, where prior 20-bar high is 209.164 and prior low is 208.326.
  // Last bar sweeps up to 209.170, closes at 209.029 (bearish rejection).
  const baseTime = new Date("2026-11-23T00:00:00Z").getTime();
  const m15Bars: Candle[] = [];

  for (let i = 0; i < 40; i++) {
    const t = new Date(baseTime + i * 15 * 60 * 1000).toISOString();
    m15Bars.push({
      open: 208.50,
      high: 208.90,
      low: 208.40,
      close: 208.60,
      time: t,
    });
  }

  // Bar 38 sets prior 20-bar high to 209.164, low to 208.326
  m15Bars.push({
    open: 208.70,
    high: 209.164,
    low: 208.326,
    close: 208.80,
    time: new Date(baseTime + 38 * 15 * 60 * 1000).toISOString(),
  });

  // Final M15 closed bar: sweeps to 209.170, closes down at 209.029 (Rejection)
  m15Bars.push({
    open: 209.127,
    high: 209.170,
    low: 209.000,
    close: 209.029,
    time: "2026-11-23T08:45:00.000Z",
  });

  // H1 candles: Bullish EMA10 > EMA20 (like Nov 23 08:00 UTC)
  const h1Bars: Candle[] = [];
  for (let i = 0; i < 30; i++) {
    const t = new Date(baseTime + i * 60 * 60 * 1000).toISOString();
    h1Bars.push({
      open: 207.50 + i * 0.05,
      high: 207.80 + i * 0.05,
      low: 207.40 + i * 0.05,
      close: 207.75 + i * 0.05,
      time: t,
    });
  }

  // ── TEST 1: Replicate Nov 23 09:10 UTC APEX SELL Signal ──────────────────
  const apexReplayDate = new Date("2026-11-23T09:10:07Z");
  const resApex = evaluateGbpJpyConfluence(
    m15Bars,
    h1Bars,
    undefined,
    { bid: 208.911, ask: 208.941, spread_pips: 3.0 },
    apexReplayDate,
    true
  );

  assert(resApex.passed === true, "1a. Apex confluence synthesizer fires at 09:10 UTC");
  assert(resApex.confluenceGrade === "A", `1b. Confluence grade is A (got ${resApex.confluenceGrade})`);
  assert(resApex.decision === "SELL", `1c. Direction is SELL (got ${resApex.decision})`);
  assert(resApex.totalScore >= 80, `1d. Confluence score is >= 80 (got ${resApex.totalScore})`);
  assert(resApex.setup !== null, "1e. Setup object is generated");
  assert(resApex.setup?.entry === 208.911, `1f. Entry fills at live bid 208.911 (got ${resApex.setup?.entry})`);
  assert(resApex.setup ? resApex.setup.sl > resApex.setup.entry : false, "1g. SELL SL is above entry");
  assert(resApex.setup ? resApex.setup.tp1 < resApex.setup.entry : false, "1h. SELL TP1 is below entry");
  assert(resApex.setup ? resApex.setup.tp2 < resApex.setup.tp1 : false, "1i. SELL TP2 runner is below TP1");

  // ── TEST 2: Confluence Mode Toggle OFF (Pure Trend Sweep Only) ───────────
  const resPure = evaluateGbpJpyConfluence(
    m15Bars,
    h1Bars,
    undefined,
    { bid: 208.911, ask: 208.941, spread_pips: 3.0 },
    apexReplayDate,
    false // Confluence mode OFF
  );

  assert(resPure.passed === false, "2a. Pure Trend Sweep rejects counter-trend sweep when mode is false");
  assert(resPure.confluenceGrade === "WAIT", `2b. Pure mode grade is WAIT (got ${resPure.confluenceGrade})`);

  // ── TEST 3: Outside Kill Zone Blocks Confluence Synthesizer ──────────────
  const asianDate = new Date("2026-11-23T03:00:00Z"); // 04:00 WAT (Asian dead zone)
  const resAsian = evaluateGbpJpyConfluence(
    m15Bars,
    h1Bars,
    undefined,
    { bid: 208.911, ask: 208.941, spread_pips: 3.0 },
    asianDate,
    true
  );

  assert(resAsian.isKillZone === false, "3a. Correctly flags Asian session as outside Kill Zone");
  assert(resAsian.passed === false, "3b. Blocks synthesis outside Kill Zone");

  // ── TEST 4: Buy-Side Liquidity Sweep Synthesis ───────────────────────────
  const m15BuyBars: Candle[] = [...m15Bars.slice(0, -1)];
  // Sweep below prior low 208.326, close back above with bullish body
  m15BuyBars.push({
    open: 208.350,
    high: 208.550,
    low: 208.280, // swept low
    close: 208.500, // closed back inside bullish
    time: "2026-11-23T08:45:00.000Z",
  });

  const resBuy = evaluateGbpJpyConfluence(
    m15BuyBars,
    h1Bars,
    undefined,
    { bid: 208.500, ask: 208.530, spread_pips: 3.0 },
    apexReplayDate,
    true
  );

  assert(resBuy.passed === true, "4a. BUY liquidity sweep passes");
  assert(resBuy.decision === "BUY", `4b. Decision is BUY (got ${resBuy.decision})`);
  assert(resBuy.setup ? resBuy.setup.sl < resBuy.setup.entry : false, "4c. BUY SL is below entry");
  assert(resBuy.setup ? resBuy.setup.tp1 > resBuy.setup.entry : false, "4d. BUY TP1 is above entry");

  console.log("=== RESULT: 17 passed, 0 failed ===");
}

runConfluenceTests().catch((err) => {
  console.error("Test execution failure:", err);
  process.exit(1);
});
