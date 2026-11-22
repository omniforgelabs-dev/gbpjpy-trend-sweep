/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DYNAMIC POSITION SIZER & RISK ENGINE (GBP/JPY)
 * ═══════════════════════════════════════════════════════════════════════════
 * Implements dynamic position sizing optimized for micro/cent and standard accounts:
 * - Starting account balance: ~$10 USD
 * - Intended minimum starting lot: 0.001 lots (subject to broker volumeMin/volumeStep)
 * - Maximum intended risk: $1.00 USD per trade (configurable, not rigid/compulsory)
 * - Proportional risk scaling for lower R:R setups instead of automatic rejection
 * - Strict preservation of original strategy entry and stop-loss levels
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { PIP_SIZE } from "../strategy/trendSweep.js";

export interface BrokerInstrumentSpec {
  instrument: string;
  contractSize: number;  // Standard = 100,000; Cent = 1,000
  volumeMin: number;     // e.g. 0.001 or 0.01
  volumeMax: number;     // e.g. 200.0
  volumeStep: number;    // e.g. 0.001 or 0.01
  pointDigits: number;   // 3 for GBP/JPY
}

export interface PositionSizeResult {
  permittedVolume: number;
  stopDistance: number;
  stopPips: number;
  pipValuePerLotUsd: number;
  theoreticalLots: number;
  actualEstimatedRiskUsd: number;
  riskPercent: number;
  accountBalance: number;
  targetRiskUsd: number;
  rewardToRiskRatio: number;
  isScaledDown: boolean;
  notes: string[];
}

export const DEFAULT_EXNESS_GBPJPY_SPEC: BrokerInstrumentSpec = {
  instrument: "GBPJPY",
  contractSize: 100000,
  volumeMin: 0.001, // Accommodates 0.001 intended starting lot (or 0.01 standard)
  volumeMax: 200.0,
  volumeStep: 0.001,
  pointDigits: 3,
};

/**
 * Calculates dynamic position size for GBP/JPY based on live entry, SL, TP1,
 * account balance, live USD/JPY conversion rate, and broker specs.
 */
export function calculateGbpJpyPositionSize(options: {
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  accountBalance: number;
  liveUsdJpyRate: number;
  maxIntendedRiskUsd?: number;
  spec?: Partial<BrokerInstrumentSpec>;
}): PositionSizeResult {
  const {
    entryPrice,
    slPrice,
    tp1Price,
    accountBalance,
    liveUsdJpyRate,
    maxIntendedRiskUsd = 1.0,
  } = options;

  const notes: string[] = [];
  const spec: BrokerInstrumentSpec = {
    ...DEFAULT_EXNESS_GBPJPY_SPEC,
    ...options.spec,
  };

  const stopDistance = Math.abs(entryPrice - slPrice);
  const tp1Distance = Math.abs(tp1Price - entryPrice);
  const stopPips = stopDistance > 0 ? stopDistance / PIP_SIZE : 0;
  const rr = stopDistance > 0 ? tp1Distance / stopDistance : 1.0;

  // 1. Calculate JPY pip value converted to USD:
  // 1 pip on 1.00 lot = contractSize * 0.01 JPY = 1,000 JPY (standard)
  // In USD = 1,000 JPY / liveUsdJpyRate
  const usdJpy = liveUsdJpyRate > 0 ? liveUsdJpyRate : 155.0;
  const pipValuePerLotUsd = (spec.contractSize * PIP_SIZE) / usdJpy;

  // 2. Base target risk is capped at maxIntendedRiskUsd or 10% of balance (whichever is lower)
  let effectiveTargetRisk = Math.min(maxIntendedRiskUsd, accountBalance * 0.10);
  effectiveTargetRisk = Math.max(0.10, effectiveTargetRisk);

  // 3. User requirement: "If a setup offers a lower reward-to-risk ratio, reduce the dollar risk accordingly
  //    rather than automatically rejecting the trade. Preserve the original strategy's setup and trade opportunities."
  let isScaledDown = false;
  if (rr < 1.0 && rr > 0.3) {
    const scaleFactor = Math.max(0.4, rr);
    effectiveTargetRisk *= scaleFactor;
    isScaledDown = true;
    notes.push(`[RISK] Lower R:R (${rr.toFixed(2)}) detected: scaled dollar risk down to $${effectiveTargetRisk.toFixed(2)}`);
  }

  // 4. Theoretical volume
  const costPerPipUsd = pipValuePerLotUsd;
  const riskPerLotUsd = stopPips * costPerPipUsd;
  const rawLots = riskPerLotUsd > 0 ? effectiveTargetRisk / riskPerLotUsd : spec.volumeMin;

  // 5. Volume quantization according to broker volumeStep & volumeMin
  const step = spec.volumeStep > 0 ? spec.volumeStep : 0.001;
  const decimals = step < 0.01 ? 3 : 2;

  let permittedVolume = Math.floor(rawLots / step) * step;
  permittedVolume = Number(permittedVolume.toFixed(decimals));

  if (permittedVolume < spec.volumeMin) {
    permittedVolume = spec.volumeMin;
    notes.push(`[RISK] Quantized volume floored to broker volumeMin (${spec.volumeMin} lots)`);
  }

  if (permittedVolume > spec.volumeMax) {
    permittedVolume = spec.volumeMax;
  }

  // 6. Actual estimated dollar risk at permitted volume
  const actualEstimatedRiskUsd = Number((permittedVolume * stopPips * pipValuePerLotUsd).toFixed(2));
  const riskPercent = accountBalance > 0 ? Number(((actualEstimatedRiskUsd / accountBalance) * 100).toFixed(1)) : 0;

  // 7. Safety check: If risk at volumeMin is higher than intended risk, we warn but do NOT modify entry/SL
  if (actualEstimatedRiskUsd > maxIntendedRiskUsd) {
    notes.push(`[RISK] At volumeMin (${spec.volumeMin}), risk is $${actualEstimatedRiskUsd.toFixed(2)} (slight overshoot of intended $${maxIntendedRiskUsd.toFixed(2)} target)`);
  } else {
    notes.push(`[RISK] Optimal lot: ${permittedVolume} lots (risk: $${actualEstimatedRiskUsd.toFixed(2)} / ${riskPercent}% of $${accountBalance.toFixed(2)})`);
  }

  return {
    permittedVolume,
    stopDistance: Number(stopDistance.toFixed(3)),
    stopPips: Number(stopPips.toFixed(1)),
    pipValuePerLotUsd: Number(pipValuePerLotUsd.toFixed(4)),
    theoreticalLots: Number(rawLots.toFixed(4)),
    actualEstimatedRiskUsd,
    riskPercent,
    accountBalance,
    targetRiskUsd: Number(effectiveTargetRisk.toFixed(2)),
    rewardToRiskRatio: Number(rr.toFixed(2)),
    isScaledDown,
    notes,
  };
}
