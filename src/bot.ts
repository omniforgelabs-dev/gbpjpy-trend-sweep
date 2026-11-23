/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GBP/JPY TREND SWEEP HEADLESS TRADING BOT (MAIN ENTRYPOINT)
 * ═══════════════════════════════════════════════════════════════════════════
 * Lightweight, production-ready, zero-UI background worker for Render.
 * 
 * Features:
 * - 100% Dedicated to GBP/JPY.
 * - Original Trend Sweep Strategy (Zero-Lookahead M15 Sweep + H1 Trend).
 * - Dynamic Position Sizing ($1.00 max intended risk, adapts to broker minLot).
 * - Dual Exness Demo & Live Mode (swapped purely via environment variables).
 * - Crash-resistant persistent state management across restarts.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import http from "node:http";
import { ExnessClient } from "./broker/exnessClient.js";
import { StateManager, ManagedTradeState } from "./state/stateManager.js";
import { Candle, parseIsoSeconds } from "./strategy/trendSweep.js";
import { evaluateGbpJpyConfluence } from "./strategy/confluenceEvaluator.js";
import { calculateGbpJpyPositionSize } from "./risk/positionSizer.js";
import { startHealthServer, BotHealthStatus, HealthStatusProvider } from "./healthServer.js";

// Configuration options from environment
const CHECK_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "60000", 10);
const MAX_RISK_USD = parseFloat(process.env.MAX_RISK_USD || "1.00");
const CONFLUENCE_MODE = process.env.CONFLUENCE_MODE !== "false"; // default true (APEX 1-to-1 Confluence Parity)

export class GbpJpyBot implements HealthStatusProvider {
  private exness: ExnessClient;
  private state: StateManager;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private httpServer: http.Server | null = null;
  private startTime = Date.now();
  private lastHeartbeat = new Date().toISOString();
  private lastScanCheck = "Initializing";
  private lastScanRegime = "UNCLEAR";
  private lastScanScore = 0;

  constructor() {
    this.exness = new ExnessClient();
    this.state = new StateManager();
  }

  public async start(): Promise<void> {
    this.isRunning = true;
    this.startTime = Date.now();
    this.lastHeartbeat = new Date().toISOString();

    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  GBP/JPY TREND SWEEP AUTOMATED TRADING BOT");
    console.log("  Preserved Original Strategy · Exness Direct API v1.0.2");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  Environment Mode:    ${this.exness.isDemoAccount() ? "DEMO (Testing)" : "LIVE REAL ACCOUNT"}`);
    console.log(`  Execution Engine:    ${this.exness.isSimulated() ? "SANDBOX SIMULATION" : "EXNESS DIRECT REST API"}`);
    console.log(`  Confluence Mode:     ${CONFLUENCE_MODE ? "ENABLED (APEX 1-to-1 Confluence Parity)" : "DISABLED (Pure Trend Sweep Only)"}`);
    console.log(`  Gateway Host:        ${this.exness.getConfiguredGatewayHost()}`);
    console.log(`  State Mount File:    ${this.state.getFilePath()}`);
    console.log(`  Max Intended Risk:   $${MAX_RISK_USD.toFixed(2)} USD per trade`);
    console.log(`  Poll Interval:       ${CHECK_INTERVAL_MS / 1000}s`);
    console.log("═══════════════════════════════════════════════════════════════\n");

    // Start lightweight HTTP health server on 0.0.0.0:PORT (Render Web Service)
    const port = process.env.PORT || 10000;
    this.httpServer = startHealthServer(port, this);

    // Initial account verification
    try {
      const acc = await this.exness.getAccount();
      console.log(`[INIT] Account ${acc.accountId} connected: Balance $${acc.balance.toFixed(2)} ${acc.currency} (Demo: ${acc.isDemo})`);
    } catch (e: any) {
      console.warn(`[INIT] Warning during initial account check: ${e.message}`);
    }

    // Check recovered state
    const recovered = this.state.getActiveTrade();
    if (recovered) {
      console.log(`[STATE] Recovered existing active trade: ${recovered.tradeId} (${recovered.direction} @ ${recovered.entryPrice}, TP1 Hit: ${recovered.tp1Hit})`);
    } else {
      console.log("[STATE] Ready for new signals. No active GBP/JPY trade pending.");
    }

    // Run first iteration immediately, then schedule
    await this.runIteration();
    this.timer = setInterval(() => this.runIteration(), CHECK_INTERVAL_MS);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    this.state.saveState();
    console.log("[BOT] Bot and health server stopped gracefully. State saved.");
  }

  public getHealthStatus(): BotHealthStatus {
    const active = this.state.getActiveTrade();
    return {
      status: this.isRunning ? "healthy" : "stopped",
      service: "gbpjpy-trend-sweep",
      pair: "GBP/JPY",
      mode: this.exness.isDemoAccount() ? "demo" : "live",
      executionEngine: this.exness.isSimulated() ? "simulation" : "exness-rest-api",
      confluenceMode: CONFLUENCE_MODE,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      activeTrade: active !== null,
      activeTradeId: active?.tradeId || null,
      lastHeartbeat: this.lastHeartbeat,
      lastScanCheck: this.lastScanCheck,
      lastScanRegime: this.lastScanRegime,
      lastScanScore: this.lastScanScore,
      resolvedAccessPoint: this.exness.getResolvedAccessPoint(),
      timestamp: new Date().toISOString(),
    };
  }

  /** Single evaluation and execution cycle */
  public async runIteration(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const now = new Date();
      this.lastHeartbeat = now.toISOString();
      const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
      const dow = now.getUTCDay();

      // Weekend guard
      if (dow === 0 || dow === 6) {
        console.log(`[HEARTBEAT ${now.toISOString()}] Weekend market closed. Next scan Monday 08:00 UTC.`);
        return;
      }

      // 1. Manage Active Open Trade (Top Priority)
      let active = this.state.getActiveTrade();

      // If no local state found (e.g. after container redeploy on Render Free plan), reconcile with Exness
      if (!active && !this.exness.isSimulated()) {
        try {
          const brokerPositions = await this.exness.getOpenPositions();
          const gbpPos = brokerPositions.find((p) => {
            const clean = String(p.instrument || "").toUpperCase().replace(/[^A-Z]/g, "");
            return clean.includes("GBPJPY");
          });
          if (gbpPos) {
            console.log(`[RECONCILE] Recovered active GBP/JPY position from Exness broker: ${gbpPos.positionId} (${gbpPos.direction} ${gbpPos.volume} lots @ ${gbpPos.openPrice})`);
            const slDist = Math.abs(gbpPos.openPrice - (gbpPos.sl || (gbpPos.direction === "BUY" ? gbpPos.openPrice - 0.30 : gbpPos.openPrice + 0.30)));
            const isBe = Boolean(gbpPos.sl && Math.abs(gbpPos.sl - gbpPos.openPrice) < 0.05);
            const reconstructed: ManagedTradeState = {
              tradeId: `ts_broker_${gbpPos.positionId}`,
              brokerPositionId: gbpPos.positionId,
              pair: "GBP/JPY",
              direction: gbpPos.direction,
              entryPrice: gbpPos.openPrice,
              initialSl: gbpPos.sl || (gbpPos.direction === "BUY" ? gbpPos.openPrice - 0.30 : gbpPos.openPrice + 0.30),
              currentSl: gbpPos.sl || (gbpPos.direction === "BUY" ? gbpPos.openPrice - 0.30 : gbpPos.openPrice + 0.30),
              tp1: gbpPos.tp || (gbpPos.direction === "BUY" ? gbpPos.openPrice + slDist : gbpPos.openPrice - slDist),
              tp2: gbpPos.direction === "BUY" ? Number((gbpPos.openPrice + slDist * 2.5).toFixed(3)) : Number((gbpPos.openPrice - slDist * 2.5).toFixed(3)),
              riskDistance: slDist > 0 ? slDist : 0.30,
              volume: gbpPos.volume,
              remainingVolume: gbpPos.volume,
              tp1Hit: isBe,
              beActive: isBe,
              openedAt: gbpPos.createTime || new Date().toISOString(),
              candleBarTime: new Date().toISOString(),
              dollarRisk: MAX_RISK_USD,
              sltpOrderId: gbpPos.sltpOrderId,
            };
            this.state.recordTradeOpen(reconstructed);
            active = reconstructed;
          }
        } catch (e: any) {
          console.warn(`[RECONCILE] Broker position check warning: ${e.message}`);
        }
      }

      if (active) {
        await this.manageActiveTrade(active);
        return; // While in a trade, do not evaluate new entries
      }

      // 2. Session Window Filter: Weekdays 08:00 to 15:00 UTC
      if (utcHour < 8.0 || utcHour >= 15.0) {
        console.log(`[HEARTBEAT ${now.toISOString()}] Outside trade window (${utcHour.toFixed(1)}h UTC). Active 08:00–15:00 UTC.`);
        return;
      }

      // 3. Fetch Market Data for Evaluation
      const [m15Candles, h1Candles, d1Candles, usdJpyRate, account, liveQuote] = await Promise.all([
        this.exness.getCandles("M15", 50).catch(() => [] as Candle[]),
        this.exness.getCandles("H1", 40).catch(() => [] as Candle[]),
        this.exness.getCandles("D1", 10).catch(() => [] as Candle[]),
        this.exness.getLiveUsdJpyRate().catch(() => 155.0),
        this.exness.getAccount().catch(() => ({ balance: 10.0 })),
        this.exness.getQuote("GBPJPY").catch(() => undefined),
      ]);

      if (m15Candles.length < 35 || h1Candles.length < 25) {
        console.log(`[SCAN ${now.toISOString()}] Waiting for full candle history (${m15Candles.length}/35 M15, ${h1Candles.length}/25 H1)...`);
        return;
      }

      // Ensure we evaluate the latest CLOSED M15 candle only (drop forming bar if present)
      // Exness Market Data returns the forming candle whose timestamp is the start of the current 15m window.
      const lastM15 = m15Candles[m15Candles.length - 1];
      const lastBarSec = parseIsoSeconds(lastM15?.time);
      const nowSec = Math.floor(now.getTime() / 1000);
      const isForming = (nowSec - lastBarSec) < 900;
      const closedM15Candles = isForming && m15Candles.length > 35 ? m15Candles.slice(0, -1) : m15Candles;

      // 4. Run GBP/JPY Evaluator (APEX Confluence Mode by default, or pure Trend Sweep)
      const result = evaluateGbpJpyConfluence(
        closedM15Candles,
        h1Candles,
        d1Candles,
        liveQuote ? { bid: liveQuote.bid, ask: liveQuote.ask } : undefined,
        now,
        CONFLUENCE_MODE
      );

      this.lastScanCheck = result.checks[result.checks.length - 1] || "No signal";
      this.lastScanRegime = result.h1MacroTrend;
      this.lastScanScore = result.totalScore;

      if (!result.passed || !result.setup) {
        console.log(`[SCAN ${now.toISOString()}] GBP/JPY: ${result.h1MacroTrend} regime · ${result.confluenceGrade} (${result.totalScore}% Confluence) · ${this.lastScanCheck}`);
        return;
      }

      const s = result.setup;
      console.log(`\n🔥 [SIGNAL DETECTED via ${result.sourceEngine}] GBP/JPY ${s.direction} at ${s.entry} | SL: ${s.sl} | TP1: ${s.tp1} | TP2: ${s.tp2} (Risk Dist: ${s.risk})`);

      // 5. Deduplication and Frequency Gate
      const gate = this.state.canEnterSignal(s.barTime);
      if (!gate.allowed) {
        console.log(`[GATE] Trade blocked: ${gate.reason}`);
        return;
      }

      // 6. Dynamic Position Sizing (Preserves Original Entry and SL)
      const balance = account?.balance || 10.0;
      const sizing = calculateGbpJpyPositionSize({
        entryPrice: s.entry,
        slPrice: s.sl,
        tp1Price: s.tp1,
        accountBalance: balance,
        liveUsdJpyRate: usdJpyRate,
        maxIntendedRiskUsd: MAX_RISK_USD,
      });

      console.log(`[SIZING] Balance: $${balance.toFixed(2)} | Lots: ${sizing.permittedVolume} | Est Risk: $${sizing.actualEstimatedRiskUsd.toFixed(2)} (${sizing.riskPercent}%) | Stop: ${sizing.stopPips} pips`);
      for (const note of sizing.notes) {
        console.log(`  ${note}`);
      }

      // 7. Execute Market Order on Exness
      console.log(`[EXECUTE] Sending ${s.direction} order of ${sizing.permittedVolume} lots on GBP/JPY...`);
      const orderRes = await this.exness.openMarketOrder({
        direction: s.direction,
        volume: sizing.permittedVolume,
        sl: s.sl,
        tp1: s.tp1,
        comment: result.sourceEngine.includes("Synthesizer") ? "ApexConfluence_GBPJPY" : "TrendSweep_GBPJPY",
      });

      if (!orderRes.success) {
        console.error(`[EXECUTE FAILED] Exness rejected order: ${orderRes.error}`);
        return;
      }

      // 8. Record in Persistent State Manager
      const tradeId = `ts_${Date.now()}`;
      const managedTrade: ManagedTradeState = {
        tradeId,
        brokerPositionId: orderRes.positionId || orderRes.orderId || tradeId,
        pair: "GBP/JPY",
        direction: s.direction,
        entryPrice: orderRes.fillPrice || s.entry,
        initialSl: s.sl,
        currentSl: s.sl,
        tp1: s.tp1,
        tp2: s.tp2,
        riskDistance: s.risk,
        volume: sizing.permittedVolume,
        remainingVolume: sizing.permittedVolume,
        tp1Hit: false,
        beActive: false,
        openedAt: new Date().toISOString(),
        candleBarTime: s.barTime,
        dollarRisk: sizing.actualEstimatedRiskUsd,
      };

      this.state.recordTradeOpen(managedTrade);
      console.log(`✅ [ORDER FILLED] Trade ${tradeId} active. Position ID: ${managedTrade.brokerPositionId}\n`);
    } catch (err: any) {
      console.error(`[ERROR] Cycle error: ${err.message}`);
    }
  }

  /** Dynamic trade management: TP1 scale, Auto-BE, TP2 runner, and staleness */
  private async manageActiveTrade(t: ManagedTradeState): Promise<void> {
    try {
      const quote = await this.exness.getQuote("GBPJPY");
      const currentPrice = t.direction === "BUY" ? quote.bid : quote.ask;
      const risk = t.riskDistance > 0 ? t.riskDistance : Math.abs(t.entryPrice - t.initialSl);

      const progressR =
        t.direction === "BUY"
          ? (currentPrice - t.entryPrice) / risk
          : (t.entryPrice - currentPrice) / risk;

      console.log(`[MANAGE] ${t.pair} ${t.direction} @ ${t.entryPrice} | Cur: ${currentPrice} | Progress: ${progressR >= 0 ? "+" : ""}${progressR.toFixed(2)}R | SL: ${t.currentSl} | TP1 Hit: ${t.tp1Hit}`);

      // Check if position was closed externally by broker (e.g. SL or TP filled while bot was sleeping)
      if (!this.exness.isSimulated()) {
        const openPos = await this.exness.getOpenPositions().catch(() => null);
        if (openPos && !openPos.some((p) => p.positionId === t.brokerPositionId)) {
          console.log(`[MANAGE] Broker position ${t.brokerPositionId} was closed externally by Exness (SL/TP executed). Reconciling state.`);
          const realizedR = progressR >= 0.8 ? 1.0 : (progressR <= -0.8 ? -1.0 : Number(progressR.toFixed(2)));
          this.state.recordTradeClose(currentPrice, realizedR, realizedR * t.dollarRisk, realizedR > 0 ? "TP1_TP2" : "SL");
          return;
        }
      }

      // 1. Stage 1: Target 1 (1.00R) -> Close 50% & Move SL to Breakeven
      const tp1Triggered =
        !t.tp1Hit &&
        ((t.direction === "BUY" && currentPrice >= t.tp1) ||
          (t.direction === "SELL" && currentPrice <= t.tp1));

      if (tp1Triggered) {
        console.log(`🎯 [TP1 HIT] Target 1 reached at ${currentPrice}! Scaling out 50% and moving SL to Breakeven.`);
        const halfVolume = Number((t.volume / 2.0).toFixed(3));
        const remVolume = Number((t.volume - halfVolume).toFixed(3));

        // Close 50% on broker
        await this.exness.closePosition(t.brokerPositionId, halfVolume).catch(() => {});
        // Move SL to Breakeven (entry price)
        await this.exness.modifyPositionSl(t.brokerPositionId, t.entryPrice, t.sltpOrderId).catch(() => {});

        this.state.recordTp1Hit(t.entryPrice, remVolume);
        console.log(`[TP1 APPLIED] SL moved to BE (${t.entryPrice}). Remaining volume: ${remVolume} lots.`);
        return;
      }

      // 2. Stage 2: Target 2 (2.50R Runner) -> Close Remaining
      const tp2Triggered =
        t.tp1Hit &&
        ((t.direction === "BUY" && currentPrice >= t.tp2) ||
          (t.direction === "SELL" && currentPrice <= t.tp2));

      if (tp2Triggered) {
        console.log(`🚀 [TP2 HIT] Target 2 reached at ${currentPrice}! Closing runner.`);
        await this.exness.closePosition(t.brokerPositionId).catch(() => {});
        const netR = 0.5 * 1.0 + 0.5 * 2.5; // +1.75R to +2.0R
        const pnl = netR * t.dollarRisk;
        this.state.recordTradeClose(currentPrice, netR, pnl, "TP1_TP2");
        console.log(`✅ [TRADE CLOSED] Full win banked: +${netR.toFixed(2)}R (+$${pnl.toFixed(2)})\n`);
        return;
      }

      // 3. Breakeven Stop-out (if TP1 was hit and price pulled back to entry)
      const beStopped =
        t.beActive &&
        ((t.direction === "BUY" && currentPrice <= t.entryPrice) ||
          (t.direction === "SELL" && currentPrice >= t.entryPrice));

      if (beStopped) {
        console.log(`🛡️ [BE STOPPED] Price pulled back to entry (${t.entryPrice}). Protected win locked.`);
        await this.exness.closePosition(t.brokerPositionId).catch(() => {});
        const netR = 0.50; // Banked 50% at 1.00R, stopped at 0R
        const pnl = netR * t.dollarRisk;
        this.state.recordTradeClose(currentPrice, netR, pnl, "TP1_BE");
        console.log(`✅ [TRADE CLOSED] Protected win: +${netR.toFixed(2)}R (+$${pnl.toFixed(2)})\n`);
        return;
      }

      // 4. Initial Stop Loss Hit
      const slHit =
        !t.beActive &&
        ((t.direction === "BUY" && currentPrice <= t.initialSl) ||
          (t.direction === "SELL" && currentPrice >= t.initialSl));

      if (slHit) {
        console.log(`🛑 [SL HIT] Stop loss triggered at ${currentPrice}.`);
        await this.exness.closePosition(t.brokerPositionId).catch(() => {});
        const netR = -1.0;
        const pnl = -t.dollarRisk;
        this.state.recordTradeClose(currentPrice, netR, pnl, "SL");
        console.log(`❌ [TRADE CLOSED] Realized Loss: -1.00R (-$${Math.abs(pnl).toFixed(2)})\n`);
        return;
      }

      // 5. Staleness Exit: 8 hours (28,800s) with < 0R progress
      const ageHours = (Date.now() - new Date(t.openedAt).getTime()) / 3600000;
      if (ageHours >= 8.0 && progressR < 0.0) {
        console.log(`⏰ [STALENESS EXIT] Trade open for ${ageHours.toFixed(1)}h with negative progress (${progressR.toFixed(2)}R). Closing.`);
        await this.exness.closePosition(t.brokerPositionId).catch(() => {});
        const pnl = progressR * t.dollarRisk;
        this.state.recordTradeClose(currentPrice, progressR, pnl, "STALENESS");
        console.log(`⚠️ [TRADE CLOSED] Stale exit: ${progressR.toFixed(2)}R ($${pnl.toFixed(2)})\n`);
      }
    } catch (e: any) {
      console.error(`[MANAGE ERROR] ${e.message}`);
    }
  }
}

// Direct Execution Entry
if (process.argv[1] && process.argv[1].endsWith("bot.ts") || process.argv[1]?.endsWith("bot.js")) {
  const bot = new GbpJpyBot();

  process.on("SIGINT", () => {
    bot.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    bot.stop();
    process.exit(0);
  });

  bot.start().catch((err) => {
    console.error("Fatal bot startup failure:", err);
    process.exit(1);
  });
}
