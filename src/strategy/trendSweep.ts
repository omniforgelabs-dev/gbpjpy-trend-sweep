/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GBP/JPY TREND SWEEP STRATEGY ENGINE (Zero-Lookahead Architecture)
 * ═══════════════════════════════════════════════════════════════════════════
 * Preserved original Trend-Following Liquidity Sweep with Momentum Rejection
 * as recovered from APEX commit 53f5025 and locked specification A21.
 *
 * SPECIFICATION RULES:
 * 1. Asset: GBP/JPY (Pip size 0.01, standard point digits 3).
 * 2. Macro Trend Filter (Strictly Completed H1 Bars Only):
 *    - Guarantee: Uses H1 candle completed >= 3600s prior to current M15 bar.
 *    - BUY:  H1 EMA(10) > H1 EMA(20) and Completed H1 Close > H1 EMA(10).
 *    - SELL: H1 EMA(10) < H1 EMA(20) and Completed H1 Close < H1 EMA(10).
 * 3. Session Window:
 *    - Weekdays 08:00 to 15:00 UTC (09:00 to 16:00 WAT, European London/NY overlap).
 * 4. M15 Micro Liquidity Sweep:
 *    - Lookback: 20 M15 bars (prior 5 hours of structural price action).
 *    - BUY: M15 sweeps below prior 20-bar low, but closes back above it, bullish.
 *    - SELL: M15 sweeps above prior 20-bar high, but closes back below it, bearish.
 *    - Candle Rejection: Solid body >= 40% of range OR pin-bar wick >= 40%.
 * 5. Stop Loss & Risk Bounds:
 *    - BUY SL = sweep low - 1.2x M15 ATR(14).
 *    - SELL SL = sweep high + 1.2x M15 ATR(14).
 *    - Minimum SL distance = 0.3x M15 ATR(14) (prevents sub-pip artifacts).
 * 6. Target Scaling & Trade Management:
 *    - Target 1 (50% scale): 1.00R (Locks +0.50R, moves SL to Breakeven).
 *    - Target 2 (50% runner): 2.50R (or Daily R1/S1 pivot if >= 1.50R).
 *    - Max Staleness: 8 hours (32 M15 bars) with < 0R progress.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  time?: number | string;
}

export type Direction = "BUY" | "SELL";

export interface TrendSweepSetup {
  pair: "GBP/JPY";
  direction: Direction;
  entry: number;
  sl: number;
  tp1: number;          // 1.00R (50% scale, auto-BE)
  tp2: number;          // 2.50R (50% runner)
  risk: number;         // Monetary risk distance in price units (entry - sl)
  sweptLevel: number;
  sweepExtreme: number;
  m15Atr: number;
  bodyRatio: number;
  h1Ema10: number;
  h1Ema20: number;
  barTime: string;
}

export interface TrendSweepCheckResult {
  passed: boolean;
  checks: string[];
  setup: TrendSweepSetup | null;
  macroRegime: "BUY" | "SELL" | "RANGE" | "UNCLEAR";
  priorHigh: number | null;
  priorLow: number | null;
}

export const PAIR_SYMBOL = "GBP/JPY";
export const PIP_SIZE = 0.01;
export const POINT_DIGITS = 3;

/** Parse candle timestamp to epoch seconds */
export function parseIsoSeconds(t: string | number | undefined): number {
  if (!t) return Math.floor(Date.now() / 1000);
  if (typeof t === "number") return t > 1e11 ? Math.floor(t / 1000) : t;
  const clean = t.replace("Z", "").split("+")[0];
  return Math.floor(new Date(clean + "Z").getTime() / 1000);
}

/** Precision rounding for GBP/JPY (3 decimal digits) */
export function roundToGbpJpyTick(price: number): number {
  return Number(price.toFixed(3));
}

/** Compute ATR series */
export function computeAtr(candles: Candle[], period = 14): number[] {
  if (!candles || candles.length < period + 1) return new Array(candles?.length || 0).fill(0);
  const trs = [0.0];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }

  const atr = new Array(candles.length).fill(0);
  let sum = 0;
  for (let i = 1; i <= period && i < trs.length; i++) sum += trs[i];
  atr[period] = sum / period;

  for (let i = period + 1; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
  }
  return atr;
}

/** Compute EMA series */
export function computeEma(series: number[], period: number): number[] {
  if (!series || series.length < period) return new Array(series?.length || 0).fill(0);
  const k = 2.0 / (period + 1.0);
  const ema = new Array(series.length).fill(0);

  let sum = 0;
  for (let i = 0; i < period; i++) sum += series[i];
  ema[period - 1] = sum / period;

  for (let i = period; i < series.length; i++) {
    ema[i] = series[i] * k + ema[i - 1] * (1.0 - k);
  }
  return ema;
}

/**
 * Finds the latest completed H1 candle relative to an M15 timestamp.
 * Guarantee: The H1 candle MUST have started at least 3600 seconds prior to 'm15TimeSeconds'.
 */
export function findCompletedH1Index(h1Candles: Candle[], m15TimeSeconds: number): number {
  if (!h1Candles || h1Candles.length === 0) return -1;
  const cutoff = m15TimeSeconds - 3600.0;
  let lo = 0;
  let hi = h1Candles.length;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const tH1 = parseIsoSeconds(h1Candles[mid].time);
    if (tH1 <= cutoff) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - 1;
}

/**
 * Evaluates whether an M15 candle produces a valid GBP/JPY Trend Sweep setup.
 *
 * @param m15Candles Array of closed M15 candles
 * @param h1Candles Array of H1 candles
 * @param m15Index Index of candle to evaluate (defaults to last candle)
 * @param d1Candles Optional D1 candles for Daily Pivot target calculation
 */
export function evaluateGbpJpyTrendSweep(
  m15Candles: Candle[],
  h1Candles: Candle[],
  m15Index?: number,
  d1Candles?: Candle[]
): TrendSweepCheckResult {
  const checks: string[] = [];

  const idx = m15Index !== undefined ? m15Index : m15Candles.length - 1;
  if (!m15Candles || m15Candles.length < 35 || idx < 20 || !h1Candles || h1Candles.length < 25) {
    checks.push("[X] Insufficient historical data (need 35+ M15 and 25+ H1 candles)");
    return { passed: false, checks, setup: null, macroRegime: "UNCLEAR", priorHigh: null, priorLow: null };
  }

  const bar = m15Candles[idx];
  const barSec = parseIsoSeconds(bar.time);
  const dt = new Date(barSec * 1000);
  const hour = dt.getUTCHours() + dt.getUTCMinutes() / 60;
  const dow = dt.getUTCDay();

  // Session Window: Weekdays 08:00 to 15:00 UTC
  const isWeekday = dow >= 1 && dow <= 5;
  const inWindow = hour >= 8.0 && hour < 15.0;

  if (!isWeekday) {
    checks.push("[X] Weekend: Outside active market days");
  } else if (!inWindow) {
    checks.push(`[INFO] Outside session window: ${hour.toFixed(2)}h UTC (active 08:00–15:00 UTC)`);
  } else {
    checks.push(`[OK] Window Active: ${hour.toFixed(2)}h UTC (08:00–15:00 UTC)`);
  }

  // Locate latest fully completed H1 candle (Zero Lookahead)
  const h1Idx = findCompletedH1Index(h1Candles, barSec);
  if (h1Idx < 20) {
    checks.push("[X] Insufficient completed H1 bars before current time");
    return { passed: false, checks, setup: null, macroRegime: "UNCLEAR", priorHigh: null, priorLow: null };
  }

  const h1Closes = h1Candles.map((c) => c.close);
  const ema10 = computeEma(h1Closes, 10);
  const ema20 = computeEma(h1Closes, 20);

  const completedH1Bar = h1Candles[h1Idx];
  const e10Val = ema10[h1Idx];
  const e20Val = ema20[h1Idx];

  let macroRegime: "BUY" | "SELL" | "RANGE" | "UNCLEAR" = "RANGE";
  if (e10Val > e20Val && completedH1Bar.close > e10Val) {
    macroRegime = "BUY";
    checks.push(`[OK] Macro H1 Trend: BULLISH (EMA10 ${roundToGbpJpyTick(e10Val)} > EMA20 ${roundToGbpJpyTick(e20Val)} & Close ${roundToGbpJpyTick(completedH1Bar.close)} > EMA10)`);
  } else if (e10Val < e20Val && completedH1Bar.close < e10Val) {
    macroRegime = "SELL";
    checks.push(`[OK] Macro H1 Trend: BEARISH (EMA10 ${roundToGbpJpyTick(e10Val)} < EMA20 ${roundToGbpJpyTick(e20Val)} & Close ${roundToGbpJpyTick(completedH1Bar.close)} < EMA10)`);
  } else {
    checks.push(`[X] Macro H1 Trend: Neutral / Counter-Trend (EMA10: ${roundToGbpJpyTick(e10Val)}, EMA20: ${roundToGbpJpyTick(e20Val)}, Close: ${roundToGbpJpyTick(completedH1Bar.close)})`);
  }

  // Prior 20-bar liquidity range
  const lookback = 20;
  const priorBars = m15Candles.slice(idx - lookback, idx);
  let priorLow = Infinity;
  let priorHigh = -Infinity;
  for (const p of priorBars) {
    if (p.low < priorLow) priorLow = p.low;
    if (p.high > priorHigh) priorHigh = p.high;
  }

  checks.push(`[OK] Prior 20-bar Range: [${roundToGbpJpyTick(priorLow)} – ${roundToGbpJpyTick(priorHigh)}]`);

  // Candle Range & Body fraction
  const candleRange = bar.high - bar.low;
  if (candleRange <= 0) {
    checks.push("[X] Zero candle range");
    return { passed: false, checks, setup: null, macroRegime, priorHigh, priorLow };
  }

  const m15Atrs = computeAtr(m15Candles, 14);
  const curAtr = m15Atrs[idx] || candleRange * 1.5;
  const bodyFraction = Math.abs(bar.close - bar.open) / candleRange;
  const lowerWickFraction = (Math.min(bar.open, bar.close) - bar.low) / candleRange;
  const upperWickFraction = (bar.high - Math.max(bar.open, bar.close)) / candleRange;

  const isHammerRejection = macroRegime === "BUY" && lowerWickFraction >= 0.40;
  const isShootingStarRejection = macroRegime === "SELL" && upperWickFraction >= 0.40;
  const bodyOk = bodyFraction >= 0.40 || isHammerRejection || isShootingStarRejection;

  if (bodyOk) {
    checks.push(`[OK] Candle Rejection: ${(Math.max(bodyFraction, lowerWickFraction, upperWickFraction) * 100).toFixed(0)}% rejection (${bodyFraction >= 0.40 ? "solid body" : "institutional pin bar"})`);
  } else {
    checks.push(`[X] Weak candle rejection: ${(bodyFraction * 100).toFixed(0)}% body & wicks (< 40% required)`);
  }

  if (!inWindow || !isWeekday || (macroRegime !== "BUY" && macroRegime !== "SELL") || !bodyOk) {
    return { passed: false, checks, setup: null, macroRegime, priorHigh, priorLow };
  }

  const minStop = 0.3 * curAtr;

  // ── BUY Setup ─────────────────────────────────────────────────────────────
  if (macroRegime === "BUY") {
    const sweptSellLiquidity = bar.low < priorLow;
    const closedBackInside = bar.close > priorLow;
    const isBullishCandle = bar.close > bar.open;

    if (sweptSellLiquidity && closedBackInside && isBullishCandle) {
      const entry = roundToGbpJpyTick(bar.close);
      const slRaw = bar.low - 1.2 * curAtr;
      let sl = roundToGbpJpyTick(slRaw);

      // Floor SL distance to minStop = 0.3x ATR
      if (entry - sl < minStop) {
        sl = roundToGbpJpyTick(entry - minStop);
      }

      const risk = roundToGbpJpyTick(entry - sl);

      if (risk > 0) {
        // Structural TP1 anchoring: front-run prior 20-bar high by 2 pips (0.02)
        const structuralTarget =
          priorHigh > entry && priorHigh - 0.02 - entry >= 1.0 * risk
            ? priorHigh - 0.02
            : entry + 1.5 * risk;
        const tp1 = roundToGbpJpyTick(Math.min(entry + 2.0 * risk, Math.max(entry + 1.0 * risk, structuralTarget)));
        let tp2 = roundToGbpJpyTick(entry + 2.5 * risk);
        let tp2Note = "2.50R Runner";

        if (d1Candles && d1Candles.length >= 2) {
          const lastD1 = d1Candles[d1Candles.length - 1];
          const H = lastD1.high;
          const L = lastD1.low;
          const C = lastD1.close;
          const P = (H + L + C) / 3.0;
          const R1 = 2.0 * P - L;
          if (R1 - entry >= 1.5 * risk) {
            tp2 = roundToGbpJpyTick(R1);
            tp2Note = `Daily R1 Pivot (${tp2})`;
          }
        }

        checks.push(`[OK] LIQUIDITY SWEEP BUY: Swept Low ${roundToGbpJpyTick(priorLow)} -> Rejection Wick ${roundToGbpJpyTick(bar.low)}`);
        checks.push(`[OK] Entry: ${entry} | SL: ${sl} | Risk: ${risk}`);
        checks.push(`[OK] Target 1 (50%): ${tp1} (1.00R) -> Move SL to BE`);
        checks.push(`[OK] Target 2 (50%): ${tp2} (${tp2Note})`);

        const setup: TrendSweepSetup = {
          pair: "GBP/JPY",
          direction: "BUY",
          entry,
          sl,
          tp1,
          tp2,
          risk,
          sweptLevel: roundToGbpJpyTick(priorLow),
          sweepExtreme: roundToGbpJpyTick(bar.low),
          m15Atr: roundToGbpJpyTick(curAtr),
          bodyRatio: Number(bodyFraction.toFixed(2)),
          h1Ema10: roundToGbpJpyTick(e10Val),
          h1Ema20: roundToGbpJpyTick(e20Val),
          barTime: typeof bar.time === "string" ? bar.time : dt.toISOString(),
        };
        return { passed: true, checks, setup, macroRegime, priorHigh, priorLow };
      }
    }
  }

  // ── SELL Setup ────────────────────────────────────────────────────────────
  if (macroRegime === "SELL") {
    const sweptBuyLiquidity = bar.high > priorHigh;
    const closedBackInside = bar.close < priorHigh;
    const isBearishCandle = bar.close < bar.open;

    if (sweptBuyLiquidity && closedBackInside && isBearishCandle) {
      const entry = roundToGbpJpyTick(bar.close);
      const slRaw = bar.high + 1.2 * curAtr;
      let sl = roundToGbpJpyTick(slRaw);

      // Floor SL distance to minStop = 0.3x ATR
      if (sl - entry < minStop) {
        sl = roundToGbpJpyTick(entry + minStop);
      }

      const risk = roundToGbpJpyTick(sl - entry);

      if (risk > 0) {
        // Structural TP1 anchoring: front-run prior 20-bar low by 2 pips (0.02)
        const structuralTarget =
          priorLow < entry && entry - (priorLow + 0.02) >= 1.0 * risk
            ? priorLow + 0.02
            : entry - 1.5 * risk;
        const tp1 = roundToGbpJpyTick(Math.max(entry - 2.0 * risk, Math.min(entry - 1.0 * risk, structuralTarget)));
        let tp2 = roundToGbpJpyTick(entry - 2.5 * risk);
        let tp2Note = "2.50R Runner";

        if (d1Candles && d1Candles.length >= 2) {
          const lastD1 = d1Candles[d1Candles.length - 1];
          const H = lastD1.high;
          const L = lastD1.low;
          const C = lastD1.close;
          const P = (H + L + C) / 3.0;
          const S1 = 2.0 * P - H;
          if (entry - S1 >= 1.5 * risk) {
            tp2 = roundToGbpJpyTick(S1);
            tp2Note = `Daily S1 Pivot (${tp2})`;
          }
        }

        checks.push(`[OK] LIQUIDITY SWEEP SELL: Swept High ${roundToGbpJpyTick(priorHigh)} -> Rejection Wick ${roundToGbpJpyTick(bar.high)}`);
        checks.push(`[OK] Entry: ${entry} | SL: ${sl} | Risk: ${risk}`);
        checks.push(`[OK] Target 1 (50%): ${tp1} (1.00R) -> Move SL to BE`);
        checks.push(`[OK] Target 2 (50%): ${tp2} (${tp2Note})`);

        const setup: TrendSweepSetup = {
          pair: "GBP/JPY",
          direction: "SELL",
          entry,
          sl,
          tp1,
          tp2,
          risk,
          sweptLevel: roundToGbpJpyTick(priorHigh),
          sweepExtreme: roundToGbpJpyTick(bar.high),
          m15Atr: roundToGbpJpyTick(curAtr),
          bodyRatio: Number(bodyFraction.toFixed(2)),
          h1Ema10: roundToGbpJpyTick(e10Val),
          h1Ema20: roundToGbpJpyTick(e20Val),
          barTime: typeof bar.time === "string" ? bar.time : dt.toISOString(),
        };
        return { passed: true, checks, setup, macroRegime, priorHigh, priorLow };
      }
    }
  }

  checks.push("[INFO] No complete sweep and rejection match at this M15 close");
  return { passed: false, checks, setup: null, macroRegime, priorHigh, priorLow };
}
