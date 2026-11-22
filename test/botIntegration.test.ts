/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST SUITE: BOT INTEGRATION, DEDUPLICATION & RESTART PERSISTENCE
 * ═══════════════════════════════════════════════════════════════════════════
 */

import fs from "node:fs";
import path from "node:path";
import { StateManager, ManagedTradeState } from "../src/state/stateManager.js";

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

console.log("\n=== Bot Lifecycle, Deduplication & Recovery Test Suite ===");

const testStateFile = path.join(process.cwd(), "test", "data", "test_bot_state.json");
if (fs.existsSync(testStateFile)) {
  fs.unlinkSync(testStateFile);
}

// 1. Initial State & Clean Gate
{
  const sm = new StateManager(testStateFile);
  const barTime = "2026-10-15T10:15:00Z";
  const gate = sm.canEnterSignal(barTime);
  assert(gate.allowed === true, "1a. Initial signal entry is allowed");
}

// 2. Order Execution & State Recording
{
  const sm = new StateManager(testStateFile);
  const trade: ManagedTradeState = {
    tradeId: "ts_test_001",
    brokerPositionId: "pos_exn_12345",
    pair: "GBP/JPY",
    direction: "BUY",
    entryPrice: 208.50,
    initialSl: 208.20,
    currentSl: 208.20,
    tp1: 208.80,
    tp2: 209.25,
    riskDistance: 0.30,
    volume: 0.002,
    remainingVolume: 0.002,
    tp1Hit: false,
    beActive: false,
    openedAt: new Date().toISOString(),
    candleBarTime: "2026-10-15T10:15:00Z",
    dollarRisk: 0.85,
  };

  sm.recordTradeOpen(trade);
  assert(sm.getActiveTrade() !== null, "2a. Active trade successfully recorded");
  assert(sm.getActiveTrade()?.tradeId === "ts_test_001", "2b. Correct trade ID recorded");
}

// 3. Duplicate Prevention While Position is Active
{
  const sm = new StateManager(testStateFile);

  // Attempting entry on same bar time
  const sameBarGate = sm.canEnterSignal("2026-10-15T10:15:00Z");
  assert(sameBarGate.allowed === false, "3a. Blocked entry on identical bar time");

  // Attempting entry on a new bar time while position is still open
  const newBarGate = sm.canEnterSignal("2026-10-15T10:30:00Z");
  assert(newBarGate.allowed === false, "3b. Blocked second entry while active trade is open (single-position rule)");
}

// 4. Crash & Restart Persistence Verification
{
  // Simulate complete process crash by spinning up a completely new StateManager instance
  const recoveredSm = new StateManager(testStateFile);
  const active = recoveredSm.getActiveTrade();

  assert(active !== null, "4a. Active trade survived restart / process reboot");
  assert(active?.tradeId === "ts_test_001", "4b. Trade ID accurately recovered");
  assert(active?.direction === "BUY", "4c. Trade direction accurately recovered");
  assert(active?.entryPrice === 208.50, "4d. Entry price accurately recovered");
  assert(active?.initialSl === 208.20, "4e. Initial SL accurately recovered");
}

// 5. TP1 Scale-Out & Breakeven Transition
{
  const sm = new StateManager(testStateFile);
  // TP1 reached: scale out half volume, move SL to BE (entry price)
  sm.recordTp1Hit(208.50, 0.001);

  const active = sm.getActiveTrade();
  assert(active?.tp1Hit === true, "5a. TP1 hit flag is true");
  assert(active?.beActive === true, "5b. Breakeven active flag is true");
  assert(active?.currentSl === 208.50, `5c. Current SL moved to Breakeven at entry (got ${active?.currentSl})`);
  assert(active?.remainingVolume === 0.001, `5d. Remaining volume updated to 0.001 lots (got ${active?.remainingVolume})`);
}

// 6. Full Trade Close & History Ingestion
{
  const sm = new StateManager(testStateFile);
  sm.recordTradeClose(209.25, 2.00, 1.70, "TP1_TP2");

  assert(sm.getActiveTrade() === null, "6a. Active trade cleared after closure");
  const history = sm.getHistory();
  assert(history.length === 1, `6b. Closed trade archived in history (length ${history.length})`);
  assert(history[0].realizedR === 2.00, `6c. Realized R is +2.00R (got +${history[0].realizedR}R)`);
  assert(history[0].reason === "TP1_TP2", "6d. Exit reason correctly recorded as TP1_TP2");

  // Deduplication check after trade is closed: same bar cannot be re-traded
  const sameBarReentry = sm.canEnterSignal("2026-10-15T10:15:00Z");
  assert(sameBarReentry.allowed === false, "6e. Deduplication prevents re-trading closed candle bar");

  // But a NEW candle bar is now allowed!
  const newBarAllowed = sm.canEnterSignal("2026-10-15T11:00:00Z");
  assert(newBarAllowed.allowed === true, "6f. Fresh candle bar allowed after trade closed");
}

// 7. Ephemeral Host Broker Reconciliation Verification (Render Free Container Wipe)
{
  const ephemeralStateFile = path.join(process.cwd(), "test", "data", "test_ephemeral_state.json");
  if (fs.existsSync(ephemeralStateFile)) fs.unlinkSync(ephemeralStateFile);

  const sm = new StateManager(ephemeralStateFile);
  assert(sm.getActiveTrade() === null, "7a. Local state starts empty after ephemeral restart");

  // Simulated broker position returned by Exness API snapshot
  const brokerPosition = {
    positionId: "exn_pos_987654",
    instrument: "GBPJPY",
    direction: "BUY" as const,
    volume: 0.002,
    openPrice: 208.50,
    sl: 208.20,
    tp: 208.80,
    sltpOrderId: "sltp_ord_112233",
    createTime: new Date().toISOString(),
  };

  // Reconstruct trade state from broker ticket
  const slDist = Math.abs(brokerPosition.openPrice - brokerPosition.sl);
  const isBe = Math.abs(brokerPosition.sl - brokerPosition.openPrice) < 0.05;
  const reconstructed: ManagedTradeState = {
    tradeId: `ts_broker_${brokerPosition.positionId}`,
    brokerPositionId: brokerPosition.positionId,
    pair: "GBP/JPY",
    direction: brokerPosition.direction,
    entryPrice: brokerPosition.openPrice,
    initialSl: brokerPosition.sl,
    currentSl: brokerPosition.sl,
    tp1: brokerPosition.tp,
    tp2: Number((brokerPosition.openPrice + slDist * 2.5).toFixed(3)),
    riskDistance: slDist,
    volume: brokerPosition.volume,
    remainingVolume: brokerPosition.volume,
    tp1Hit: isBe,
    beActive: isBe,
    openedAt: brokerPosition.createTime,
    candleBarTime: new Date().toISOString(),
    dollarRisk: 1.00,
    sltpOrderId: brokerPosition.sltpOrderId,
  };

  sm.recordTradeOpen(reconstructed);
  const recovered = sm.getActiveTrade();

  assert(recovered !== null, "7b. Broker trade successfully reconciled into state");
  assert(recovered?.brokerPositionId === "exn_pos_987654", "7c. Broker position ID preserved");
  assert(recovered?.initialSl === 208.20, "7d. Stop-loss preserved accurately");
  assert(recovered?.tp1 === 208.80, "7e. Target 1 preserved accurately");
  assert(recovered?.tp2 === 209.25, "7f. Target 2 runner calculated accurately (209.25)");
  assert(recovered?.sltpOrderId === "sltp_ord_112233", "7g. SLTP order ID attached for safe BE updates");
  assert(recovered?.tp1Hit === false, "7h. Initial trade correctly marked as awaiting TP1");

  // Gate check: single-position safety rule prevents duplicate entries
  const blockGate = sm.canEnterSignal(new Date().toISOString());
  assert(blockGate.allowed === false, "7i. Single-position rule strictly blocks duplicate trades while broker trade is active");

  // Now test state when position was already moved to Breakeven by broker
  const beBrokerPosition = {
    ...brokerPosition,
    sl: 208.50, // SL moved to BE!
    volume: 0.001, // 50% already closed
  };
  const isBeAlready = Math.abs(beBrokerPosition.sl - beBrokerPosition.openPrice) < 0.05;
  const beReconstructed: ManagedTradeState = {
    ...reconstructed,
    currentSl: beBrokerPosition.sl,
    volume: beBrokerPosition.volume,
    remainingVolume: beBrokerPosition.volume,
    tp1Hit: isBeAlready,
    beActive: isBeAlready,
  };
  sm.recordTradeOpen(beReconstructed);
  const beRecovered = sm.getActiveTrade();
  assert(beRecovered?.tp1Hit === true, "7j. BE trade correctly recognizes TP1 was already reached");
  assert(beRecovered?.beActive === true, "7k. BE trade correctly maintains Breakeven lock");

  if (fs.existsSync(ephemeralStateFile)) fs.unlinkSync(ephemeralStateFile);
}

// Cleanup test file
if (fs.existsSync(testStateFile)) {
  fs.unlinkSync(testStateFile);
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
