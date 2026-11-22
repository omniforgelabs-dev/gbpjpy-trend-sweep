/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PERSISTENT STATE MANAGER (Crash-Resistant & Duplicate-Proof)
 * ═══════════════════════════════════════════════════════════════════════════
 * Ensures the bot survives crashes, reboots, and Render deployments without:
 * 1. Losing active trade management state (TP1, Breakeven, TP2, staleness).
 * 2. Opening duplicate entries on the same M15 signal candle.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import fs from "node:fs";
import path from "node:path";

export interface ManagedTradeState {
  tradeId: string;
  brokerPositionId: string;
  pair: "GBP/JPY";
  direction: "BUY" | "SELL";
  entryPrice: number;
  initialSl: number;
  currentSl: number;
  tp1: number;
  tp2: number;
  riskDistance: number;
  volume: number;
  remainingVolume: number;
  tp1Hit: boolean;
  beActive: boolean;
  openedAt: string;
  candleBarTime: string;
  dollarRisk: number;
}

export interface ClosedTradeRecord {
  tradeId: string;
  brokerPositionId: string;
  direction: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  initialSl: number;
  realizedR: number;
  dollarPnl: number;
  reason: "TP1_TP2" | "TP1_BE" | "SL" | "STALENESS" | "MANUAL" | "EOD";
  openedAt: string;
  closedAt: string;
}

export interface BotState {
  activeTrade: ManagedTradeState | null;
  lastExecutedBarTime: string | null;
  dailyTradesCount: Record<string, number>; // dateString -> count
  history: ClosedTradeRecord[];
  updatedAt: string;
}

export class StateManager {
  private filePath: string;
  private state: BotState;

  constructor(customPath?: string) {
    const envFile = process.env.STATE_FILE_PATH;
    const envDir = process.env.STATE_DIR;

    if (customPath) {
      this.filePath = customPath;
    } else if (envFile) {
      this.filePath = envFile;
    } else if (envDir) {
      this.filePath = path.join(envDir, "bot_state.json");
    } else {
      this.filePath = path.join(process.cwd(), "data", "bot_state.json");
    }

    this.state = this.loadState();
  }

  public getFilePath(): string {
    return this.filePath;
  }

  /** Loads state from disk or initializes defaults */
  public loadState(): BotState {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          activeTrade: parsed.activeTrade || null,
          lastExecutedBarTime: parsed.lastExecutedBarTime || null,
          dailyTradesCount: parsed.dailyTradesCount || {},
          history: parsed.history || [],
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
      }
    } catch (e: any) {
      console.warn(`[STATE] Failed to read state from ${this.filePath}: ${e.message}. Initializing clean state.`);
    }

    return {
      activeTrade: null,
      lastExecutedBarTime: null,
      dailyTradesCount: {},
      history: [],
      updatedAt: new Date().toISOString(),
    };
  }

  /** Saves state atomically to disk */
  public saveState(): void {
    try {
      this.state.updatedAt = new Date().toISOString();
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), "utf-8");
      fs.renameSync(tmpPath, this.filePath);
    } catch (e: any) {
      console.error(`[STATE] Critical error saving state to disk: ${e.message}`);
    }
  }

  /** Check if a new trade can be entered for this candle bar time */
  public canEnterSignal(barTime: string): { allowed: boolean; reason?: string } {
    // 1. Strict single-position rule: Only one active GBP/JPY trade at a time
    if (this.state.activeTrade) {
      return {
        allowed: false,
        reason: `Existing trade ${this.state.activeTrade.tradeId} (${this.state.activeTrade.direction}) is currently open and managed.`,
      };
    }

    // 2. Strict deduplication: Cannot trade the exact same bar time twice
    if (this.state.lastExecutedBarTime === barTime) {
      return {
        allowed: false,
        reason: `Signal for candle ${barTime} has already been executed. Deduplication active.`,
      };
    }

    // 3. Daily frequency limit: Max 2 trades per day for GBP/JPY
    const dayKey = barTime.split("T")[0] || new Date().toISOString().split("T")[0];
    const todayCount = this.state.dailyTradesCount[dayKey] || 0;
    if (todayCount >= 2) {
      return {
        allowed: false,
        reason: `Daily frequency limit reached (${todayCount}/2 trades on ${dayKey}).`,
      };
    }

    return { allowed: true };
  }

  /** Records newly opened trade */
  public recordTradeOpen(trade: ManagedTradeState): void {
    this.state.activeTrade = trade;
    this.state.lastExecutedBarTime = trade.candleBarTime;

    const dayKey = trade.candleBarTime.split("T")[0] || new Date().toISOString().split("T")[0];
    this.state.dailyTradesCount[dayKey] = (this.state.dailyTradesCount[dayKey] || 0) + 1;

    this.saveState();
  }

  /** Updates active trade when TP1 is hit (moves SL to BE) */
  public recordTp1Hit(newSl: number, remainingVolume: number): void {
    if (!this.state.activeTrade) return;
    this.state.activeTrade.tp1Hit = true;
    this.state.activeTrade.beActive = true;
    this.state.activeTrade.currentSl = newSl;
    this.state.activeTrade.remainingVolume = remainingVolume;
    this.saveState();
  }

  /** Closes active trade and archives to history */
  public recordTradeClose(
    exitPrice: number,
    realizedR: number,
    dollarPnl: number,
    reason: ClosedTradeRecord["reason"]
  ): void {
    if (!this.state.activeTrade) return;
    const t = this.state.activeTrade;

    const record: ClosedTradeRecord = {
      tradeId: t.tradeId,
      brokerPositionId: t.brokerPositionId,
      direction: t.direction,
      entryPrice: t.entryPrice,
      exitPrice,
      initialSl: t.initialSl,
      realizedR: Number(realizedR.toFixed(2)),
      dollarPnl: Number(dollarPnl.toFixed(2)),
      reason,
      openedAt: t.openedAt,
      closedAt: new Date().toISOString(),
    };

    this.state.history.push(record);
    this.state.activeTrade = null;
    this.saveState();
  }

  public getActiveTrade(): ManagedTradeState | null {
    return this.state.activeTrade;
  }

  public getHistory(): ClosedTradeRecord[] {
    return this.state.history;
  }
}
