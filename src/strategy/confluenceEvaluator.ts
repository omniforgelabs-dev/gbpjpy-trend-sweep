/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GBP/JPY INSTITUTIONAL CONFLUENCE ENGINE (APEX 1-TO-1 PARITY)
 * ═══════════════════════════════════════════════════════════════════════════
 * Ported directly from APEX server.ts (analyzePairConfluence) for GBP/JPY.
 * 
 * Implements:
 * 1. Primary Model A: Dedicated Trend Sweep (Zero-Lookahead M15 Sweep + H1 EMA).
 * 2. Model B: Asian Range Liquidity Fade (Mean-reversion).
 * 3. Model C: Asian Session Range Breakout.
 * 4. 100-Point Institutional Confluence Scoring Engine:
 *    - 25 pts: M15 20-bar Liquidity Sweep & Rejection
 *    - 20 pts: Session Alignment (London Open & New York Open Kill Zones)
 *    - 15 pts: Candle Displacement & Wick Rejection
 *    - 15 pts: Volatility Architecture & Spread Armor
 *    - 25 pts: Macro H1 EMA Trend Alignment
 *    - 10 pts: Multi-Model Confluence Bonus
 * 5. Automatic Fallback Synthesizer:
 *    - When totalScore >= 80, sweepPts === 25, and in Kill Zone:
 *      Fires Grade A execution with 1.2x ATR SL, opposing structural TP1,
 *      and 2.50R runner. (Exact trigger of the Nov 23 09:10 UTC APEX SELL trade).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  Candle,
  TrendSweepSetup,
  evaluateGbpJpyTrendSweep,
  computeEma,
  computeAtr,
  roundToGbpJpyTick,
  PIP_SIZE,
  POINT_DIGITS,
  Direction,
} from "./trendSweep.js";
import { evaluateAsianFade } from "./asianFade.js";
import { analyzeAsianBreakout } from "./asianBreakout.js";

export interface ConfluenceCheckResult {
  passed: boolean;
  confluenceGrade: "A+" | "A" | "B+" | "WAIT";
  decision: "BUY" | "SELL" | "WAIT";
  setup: TrendSweepSetup | null;
  totalScore: number;
  checks: string[];
  reasoning: string;
  sourceEngine: string;
  isKillZone: boolean;
  sessionName: string;
  h1MacroTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  sweepPts: number;
  trendPts: number;
  sessionPts: number;
  displacementPts: number;
  riskPts: number;
  modelBonusPts: number;
}

export function evaluateGbpJpyConfluence(
  m15Closed: Candle[],
  h1Candles: Candle[],
  d1Candles?: Candle[],
  liveQuote?: { bid: number; ask: number; spread_pips?: number },
  evalDate: Date = new Date(),
  confluenceMode = true
): ConfluenceCheckResult {
  const checks: string[] = [];

  if (!m15Closed || m15Closed.length < 35 || !h1Candles || h1Candles.length < 25) {
    checks.push("[X] Insufficient historical candle data (need >= 35 M15, >= 25 H1)");
    return {
      passed: false,
      confluenceGrade: "WAIT",
      decision: "WAIT",
      setup: null,
      totalScore: 0,
      checks,
      reasoning: "Insufficient historical data for confluence evaluation",
      sourceEngine: "None",
      isKillZone: false,
      sessionName: "Insufficient Data",
      h1MacroTrend: "NEUTRAL",
      sweepPts: 0,
      trendPts: 0,
      sessionPts: 0,
      displacementPts: 0,
      riskPts: 0,
      modelBonusPts: 0,
    };
  }

  const pSize = PIP_SIZE; // 0.01 for GBP/JPY
  const lastM15 = m15Closed[m15Closed.length - 1];
  const curBid = liveQuote ? liveQuote.bid : lastM15.close;
  const curAsk = liveQuote ? liveQuote.ask : lastM15.close;
  const curSpread = liveQuote && typeof liveQuote.spread_pips === "number"
    ? liveQuote.spread_pips
    : Number((Math.abs(curAsk - curBid) / pSize).toFixed(1));

  const gradeAEngine = "Trend Sweep (🌊)";
  const gradeBEngine = "Asian Fade (🎯)";
  const gradeCEngine = "Asian Breakout (🚀)";

  // 1. Primary Model A: Pure Dedicated Trend Sweep
  const resA = evaluateGbpJpyTrendSweep(m15Closed, h1Candles, undefined, d1Candles);
  const setupA = resA.passed && resA.setup ? resA.setup : null;

  // 2. Model B: Asian Fade
  const resB = evaluateAsianFade("GBP/JPY", m15Closed, h1Candles);
  const setupB = resB.passed && resB.setup ? resB.setup : null;

  // 3. Model C: Asian Breakout
  const resC = analyzeAsianBreakout("GBP/JPY", m15Closed, h1Candles, evalDate);
  const setupC = resC.passed && resC.setup ? resC.setup : null;

  // If confluence mode is disabled, adhere strictly to pure Trend Sweep
  if (!confluenceMode) {
    if (resA.passed && setupA) {
      return {
        passed: true,
        confluenceGrade: "A",
        decision: setupA.direction,
        setup: setupA,
        totalScore: 100,
        checks: resA.checks,
        reasoning: `Dedicated Pure Trend Sweep: ${setupA.direction} setup active`,
        sourceEngine: gradeAEngine,
        isKillZone: true,
        sessionName: "Pure Trend Sweep",
        h1MacroTrend: resA.macroRegime === "BUY" ? "BULLISH" : "BEARISH",
        sweepPts: 25,
        trendPts: 25,
        sessionPts: 20,
        displacementPts: 15,
        riskPts: 15,
        modelBonusPts: 0,
      };
    }
    return {
      passed: false,
      confluenceGrade: "WAIT",
      decision: "WAIT",
      setup: null,
      totalScore: 0,
      checks: resA.checks,
      reasoning: "Pure Trend Sweep monitoring for trend-aligned sweep",
      sourceEngine: gradeAEngine,
      isKillZone: false,
      sessionName: "Pure Mode",
      h1MacroTrend: resA.macroRegime === "BUY" ? "BULLISH" : "BEARISH",
      sweepPts: 0,
      trendPts: 0,
      sessionPts: 0,
      displacementPts: 0,
      riskPts: 0,
      modelBonusPts: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // APEX 100-POINT INSTITUTIONAL CONFLUENCE SCORING ENGINE
  // ═══════════════════════════════════════════════════════════════════
  const h1Closes = h1Candles.map((c) => c.close);
  const h1Ema10Series = computeEma(h1Closes, 10);
  const h1Ema20Series = computeEma(h1Closes, 20);
  const lastEma10 = h1Ema10Series[h1Ema10Series.length - 1] || h1Closes[h1Closes.length - 1];
  const lastEma20 = h1Ema20Series[h1Ema20Series.length - 1] || lastEma10;
  const lastH1Close = h1Closes[h1Closes.length - 1];

  let h1MacroTrend: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  if (lastEma10 > lastEma20 && lastH1Close >= lastEma10) h1MacroTrend = "BULLISH";
  else if (lastEma10 < lastEma20 && lastH1Close <= lastEma10) h1MacroTrend = "BEARISH";
  else if (lastEma10 > lastEma20) h1MacroTrend = "BULLISH";
  else if (lastEma10 < lastEma20) h1MacroTrend = "BEARISH";

  // M15 Structure & Liquidity Sweep (Last 20 Bars)
  const recent20 = m15Closed.slice(-21, -1);
  const priorHigh20 = recent20.length > 0 ? Math.max(...recent20.map((b) => b.high)) : curBid;
  const priorLow20 = recent20.length > 0 ? Math.min(...recent20.map((b) => b.low)) : curBid;
  const lastBar = m15Closed[m15Closed.length - 1];
  const prevBar = m15Closed.length >= 2 ? m15Closed[m15Closed.length - 2] : lastBar;

  const barRange = Math.max(1e-5, lastBar.high - lastBar.low);
  const body = Math.abs(lastBar.close - lastBar.open);
  const bodyRatio = body / barRange;
  const lowerWick = Math.min(lastBar.open, lastBar.close) - lastBar.low;
  const upperWick = lastBar.high - Math.max(lastBar.open, lastBar.close);

  let sweepCandidate: Direction | null = null;
  let sweptLevel = 0;
  let sweepExtreme = 0;
  let sweepPts = 0;

  if (
    (lastBar.low < priorLow20 && lastBar.close >= priorLow20) ||
    (prevBar.low < priorLow20 && lastBar.close >= priorLow20)
  ) {
    sweepCandidate = "BUY";
    sweptLevel = priorLow20;
    sweepExtreme = Math.min(lastBar.low, prevBar.low);
    sweepPts = 25;
  } else if (
    (lastBar.high > priorHigh20 && lastBar.close <= priorHigh20) ||
    (prevBar.high > priorHigh20 && lastBar.close <= priorHigh20)
  ) {
    sweepCandidate = "SELL";
    sweptLevel = priorHigh20;
    sweepExtreme = Math.max(lastBar.high, prevBar.high);
    sweepPts = 25;
  } else {
    const span = Math.max(1e-5, priorHigh20 - priorLow20);
    if ((lastBar.close - priorLow20) / span <= 0.25) {
      sweepCandidate = "BUY";
      sweptLevel = priorLow20;
      sweepExtreme = lastBar.low;
      sweepPts = 15;
    } else if ((priorHigh20 - lastBar.close) / span <= 0.25) {
      sweepCandidate = "SELL";
      sweptLevel = priorHigh20;
      sweepExtreme = lastBar.high;
      sweepPts = 15;
    } else {
      sweepPts = 5;
    }
  }

  // Direction priority: Grade A setup if triggered, else sweep candidate, else macro trend
  let candidateDir: Direction | null = (setupA ? setupA.direction : null) || sweepCandidate;
  if (!candidateDir && h1MacroTrend !== "NEUTRAL") {
    candidateDir = h1MacroTrend === "BULLISH" ? "BUY" : "SELL";
  }

  // 1. Trend Points (Max 25)
  let trendPts = 0;
  if (candidateDir === "BUY" && h1MacroTrend === "BULLISH") trendPts = 25;
  else if (candidateDir === "SELL" && h1MacroTrend === "BEARISH") trendPts = 25;
  else if (h1MacroTrend === "NEUTRAL") trendPts = 12;
  else trendPts = 5;

  // 2. Session Points (Max 20) — Lagos WAT is UTC+1
  const wat = new Date(evalDate.getTime() + 1 * 60 * 60 * 1000);
  const watMins = wat.getUTCHours() * 60 + wat.getUTCMinutes();
  let sessionPts = 0;
  let sessionName = "Outside Kill Zone";
  let isKillZone = false;
  if (watMins >= 510 && watMins <= 750) {
    sessionPts = 20;
    sessionName = "London Open Kill Zone (08:30 AM - 12:30 PM WAT)";
    isKillZone = true;
  } else if (watMins >= 810 && watMins <= 1080) {
    sessionPts = 20;
    sessionName = "New York Open Kill Zone (01:30 PM - 06:00 PM WAT)";
    isKillZone = true;
  } else if ((watMins >= 480 && watMins < 510) || (watMins > 750 && watMins <= 780)) {
    sessionPts = 10;
    sessionName = "Session Buffer Transition";
  } else {
    sessionPts = 0;
    sessionName = "Asian / Lunch Dead Zone";
  }

  // 3. Displacement & Candle Momentum (Max 15)
  let displacementPts = 0;
  if (candidateDir === "BUY") {
    if (lowerWick >= 0.40 * barRange || (bodyRatio >= 0.45 && lastBar.close > lastBar.open)) {
      displacementPts = 15;
    } else if (lastBar.close > lastBar.open) {
      displacementPts = 10;
    } else {
      displacementPts = 5;
    }
  } else if (candidateDir === "SELL") {
    if (upperWick >= 0.40 * barRange || (bodyRatio >= 0.45 && lastBar.close < lastBar.open)) {
      displacementPts = 15;
    } else if (lastBar.close < lastBar.open) {
      displacementPts = 10;
    } else {
      displacementPts = 5;
    }
  } else {
    displacementPts = 5;
  }

  // 4. Volatility & Spread Points (Max 15)
  let riskPts = 0;
  const spreadMax = 4.0; // 4 pips max for GBP/JPY
  if (curSpread <= spreadMax) riskPts += 10;
  else if (curSpread <= spreadMax * 1.5) riskPts += 5;

  const m15Atrs = computeAtr(m15Closed, 14);
  const m15AtrVal = m15Atrs[m15Atrs.length - 1] || barRange;
  if (m15AtrVal > 0) riskPts += 5;

  // 5. Multi-Model Confluence Bonus
  const dirA = setupA ? setupA.direction : null;
  const dirB = setupB ? (setupB.direction as Direction) : null;
  const dirC = setupC ? (setupC.direction as Direction) : null;

  let modelBonusPts = 0;
  if (dirA && (dirB === dirA || dirC === dirA)) modelBonusPts = 10;
  else if (dirA) modelBonusPts = 5;

  const totalScore = Math.min(100, trendPts + sweepPts + sessionPts + displacementPts + riskPts + modelBonusPts);

  // Directional Conflict Guard
  const hasConflict = (dirA && dirB && dirB !== dirA) || (dirA && dirC && dirC !== dirA);

  let confluenceGrade: "A+" | "A" | "B+" | "WAIT" = "WAIT";
  let activeSetup: TrendSweepSetup | null = null;
  let reasoning = "";

  if (hasConflict) {
    confluenceGrade = "WAIT";
    candidateDir = null;
    activeSetup = null;
    reasoning = `Directional Conflict: Models indicate opposing bias (${gradeAEngine} vs alternative). Locked to protect capital.`;
  } else if (dirA) {
    if (dirB === dirA || dirC === dirA) {
      confluenceGrade = "A+";
      activeSetup = setupA;
      candidateDir = dirA;
      reasoning = `GRADE A+ CONFLUENCE CONFIRMED (${totalScore}% Conviction): Dedicated Model (${gradeAEngine}) agrees with ${dirB === dirA ? gradeBEngine : gradeCEngine} on ${dirA}.`;
    } else {
      confluenceGrade = "A";
      activeSetup = setupA;
      candidateDir = dirA;
      reasoning = `GRADE A DEDICATED SETUP (${totalScore}% Conviction): Primary model (${gradeAEngine}) triggered a clean ${dirA} setup with zero opposing conflict.`;
    }
  } else if (dirB && dirC && dirB === dirC) {
    confluenceGrade = "B+";
    candidateDir = dirB;
    const bEntry = setupB ? setupB.entry : curBid;
    const bSl = setupB ? setupB.sl : curBid + 0.30;
    const bRisk = Math.abs(bEntry - bSl);
    activeSetup = {
      pair: "GBP/JPY",
      direction: dirB,
      entry: roundToGbpJpyTick(bEntry),
      sl: roundToGbpJpyTick(bSl),
      tp1: roundToGbpJpyTick(setupB ? setupB.tp1 : bEntry + bRisk),
      tp2: roundToGbpJpyTick(setupB ? setupB.tp2 : bEntry + 2.5 * bRisk),
      risk: roundToGbpJpyTick(bRisk),
      sweptLevel: roundToGbpJpyTick(setupB?.asianHigh || priorHigh20),
      sweepExtreme: roundToGbpJpyTick(setupB?.asianHigh || priorHigh20),
      m15Atr: roundToGbpJpyTick(m15AtrVal),
      bodyRatio: Number(bodyRatio.toFixed(2)),
      h1Ema10: roundToGbpJpyTick(lastEma10),
      h1Ema20: roundToGbpJpyTick(lastEma20),
      barTime: typeof lastBar.time === "string" ? lastBar.time : evalDate.toISOString(),
    };
    reasoning = `GRADE B+ SECONDARY CONFLUENCE (${totalScore}% Conviction): Alternative models (${gradeBEngine} & ${gradeCEngine}) agree on ${dirB}. (Primary model is quiet).`;
  } else if (totalScore >= 80 && sweepPts === 25 && isKillZone && candidateDir) {
    // ════════════════════════════════════════════════════════════════
    // AUTOMATIC GRADE A CONFLUENCE SYNTHESIZER (APEX Fallback)
    // ════════════════════════════════════════════════════════════════
    confluenceGrade = "A";
    const entryP = candidateDir === "BUY" ? curAsk : curBid;
    const slBuffer = 1.2 * m15AtrVal;
    const extreme = sweepExtreme > 0 ? sweepExtreme : (candidateDir === "BUY" ? priorLow20 : priorHigh20);
    const slP = candidateDir === "BUY" ? extreme - slBuffer : extreme + slBuffer;
    const rDist = Math.max(pSize * 10, Math.abs(entryP - slP));

    // Structural TP anchoring: 2 pips inside opposing 20-bar liquidity extreme
    let tp1P = 0;
    if (candidateDir === "BUY") {
      const structuralHigh =
        priorHigh20 > entryP && priorHigh20 - 2 * pSize - entryP >= 1.2 * rDist
          ? priorHigh20 - 2 * pSize
          : entryP + 1.5 * rDist;
      tp1P = Number(Math.min(entryP + 2.0 * rDist, structuralHigh).toFixed(POINT_DIGITS));
    } else {
      const structuralLow =
        priorLow20 < entryP && entryP - (priorLow20 + 2 * pSize) >= 1.2 * rDist
          ? priorLow20 + 2 * pSize
          : entryP - 1.5 * rDist;
      tp1P = Number(Math.max(entryP - 2.0 * rDist, structuralLow).toFixed(POINT_DIGITS));
    }
    const tp2P = candidateDir === "BUY"
      ? Number((entryP + 2.5 * rDist).toFixed(POINT_DIGITS))
      : Number((entryP - 2.5 * rDist).toFixed(POINT_DIGITS));

    activeSetup = {
      pair: "GBP/JPY",
      direction: candidateDir,
      entry: roundToGbpJpyTick(entryP),
      sl: roundToGbpJpyTick(slP),
      tp1: tp1P,
      tp2: tp2P,
      risk: roundToGbpJpyTick(Math.abs(entryP - slP)),
      sweptLevel: roundToGbpJpyTick(sweptLevel),
      sweepExtreme: roundToGbpJpyTick(sweepExtreme),
      m15Atr: roundToGbpJpyTick(m15AtrVal),
      bodyRatio: Number(bodyRatio.toFixed(2)),
      h1Ema10: roundToGbpJpyTick(lastEma10),
      h1Ema20: roundToGbpJpyTick(lastEma20),
      barTime: typeof lastBar.time === "string" ? lastBar.time : evalDate.toISOString(),
    };
    reasoning = `GRADE A HIGH-CONFLUENCE SETUP (${totalScore}% Conviction): Confirmed 20-bar liquidity sweep, trend alignment, and rejection displacement during ${sessionName}.`;
  } else {
    confluenceGrade = "WAIT";
    candidateDir = null;
    activeSetup = null;
    reasoning = `STATUS: WAITING FOR DEDICATED SETUP (${totalScore}% Confluence Score). Primary model (${gradeAEngine}) is monitoring for strict structural alignment. No forced trades.`;
  }

  // Record validation diagnostic checks
  checks.push(`[OK] H1 Macro Trend: ${h1MacroTrend} (EMA10 ${roundToGbpJpyTick(lastEma10)} vs EMA20 ${roundToGbpJpyTick(lastEma20)})`);
  checks.push(`[OK] Prior 20-bar Range: [${roundToGbpJpyTick(priorLow20)} – ${roundToGbpJpyTick(priorHigh20)}]`);
  checks.push(`[OK] Session: ${sessionName} (${sessionPts}/20 pts)`);
  checks.push(`[OK] Sweep Scoring: ${sweepPts}/25 pts (Swept Level: ${roundToGbpJpyTick(sweptLevel)}, Extreme: ${roundToGbpJpyTick(sweepExtreme)})`);
  checks.push(`[OK] Displacement: ${displacementPts}/15 pts | Volatility/Spread: ${riskPts}/15 pts (Spread: ${curSpread} pips)`);
  checks.push(`[OK] Confluence Score: ${totalScore}/100 pts · Verdict: ${confluenceGrade} ${candidateDir || "WAIT"}`);

  return {
    passed: (confluenceGrade === "A+" || confluenceGrade === "A") && activeSetup !== null,
    confluenceGrade,
    decision: activeSetup ? activeSetup.direction : "WAIT",
    setup: activeSetup,
    totalScore,
    checks,
    reasoning,
    sourceEngine: setupA ? gradeAEngine : "Institutional Confluence Synthesizer",
    isKillZone,
    sessionName,
    h1MacroTrend,
    sweepPts,
    trendPts,
    sessionPts,
    displacementPts,
    riskPts,
    modelBonusPts,
  };
}
