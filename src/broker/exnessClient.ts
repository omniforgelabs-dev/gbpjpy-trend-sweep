/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXNESS TRADING API BROKER CLIENT (Demo & Live Unified)
 * ═══════════════════════════════════════════════════════════════════════════
 * Direct integration with Exness Trading API v1.0.2:
 * - Native RFC 8032 Ed25519 Request Signing with SHA-256 Body Hash & EXN-* Headers
 * - Automatic Access Point Discovery with In-Memory Caching
 * - Single Codebase for Demo and Live: toggled purely via environment variables:
 *     EXN_API_KEY, EXN_PRIVATE_KEY, EXN_ACCOUNT_ID, EXN_DISCOVERY_BASE_URL, EXN_IS_DEMO
 * - High-Fidelity Simulation Fallback for zero-credential / offline testing
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { Candle } from "../strategy/trendSweep.js";
import { BrokerInstrumentSpec, DEFAULT_EXNESS_GBPJPY_SPEC } from "../risk/positionSizer.js";

export interface ExnessClientConfig {
  apiKey: string;
  privateKey: string;
  accountId: string;
  discoveryBaseUrl: string;
  isDemo: boolean;
  dryRun?: boolean;
}

export interface ExnessAccountInfo {
  accountId: string;
  balance: number;
  equity: number;
  freeMargin: number;
  currency: string;
  isDemo: boolean;
  isSimulated?: boolean;
}

export interface ExnessQuote {
  instrument: string;
  bid: number;
  ask: number;
  timestamp: string;
}

export interface ExnessOpenOrderRequest {
  direction: "BUY" | "SELL";
  volume: number;
  sl: number;
  tp1: number;
  tp2?: number;
  comment?: string;
}

export interface ExnessOrderResponse {
  success: boolean;
  orderId?: string;
  positionId?: string;
  direction: "BUY" | "SELL";
  volume: number;
  fillPrice: number;
  sl: number;
  tp: number;
  createTime: string;
  isSimulated?: boolean;
  error?: string;
}

export interface ExnessPositionItem {
  positionId: string;
  instrument: string;
  direction: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  sl: number;
  tp: number;
  currentPrice?: number;
  profit?: number;
  createTime: string;
  comment?: string;
}

/**
 * Loads an Ed25519 private key from 128-character hex string or PKCS#8 PEM.
 */
export function loadEd25519Key(keyInput: string): KeyObject {
  const input = keyInput.trim();
  if (input.startsWith("-----BEGIN PRIVATE KEY-----")) {
    return createPrivateKey(input);
  }

  if (!/^[0-9a-fA-F]{128}$/.test(input)) {
    throw new Error("Invalid Ed25519 key: must be 128 hex characters or PKCS#8 PEM string");
  }

  const raw = Buffer.from(input, "hex");
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    raw.subarray(0, 32),
  ]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });

  const publicJwk = createPublicKey(key).export({ format: "jwk" });
  if (!Buffer.from(publicJwk.x ?? "", "base64url").equals(raw.subarray(32))) {
    throw new Error("Private key public half does not match seed");
  }

  return key;
}

export class ExnessClient {
  private config: ExnessClientConfig;
  private keyObject: KeyObject | null = null;
  private accessPointUrl: string | null = null;
  private accessPointCachedAt = 0;
  private isSimulationMode = false;

  // In-memory simulated state for offline testing or dry-run mode
  private simBalance = 10.0;
  private simPositions: Map<string, ExnessPositionItem> = new Map();

  constructor(config: Partial<ExnessClientConfig> = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.EXN_API_KEY || "",
      privateKey: config.privateKey || process.env.EXN_PRIVATE_KEY || "",
      accountId: config.accountId || process.env.EXN_ACCOUNT_ID || "",
      discoveryBaseUrl:
        config.discoveryBaseUrl ||
        process.env.EXN_DISCOVERY_BASE_URL ||
        "https://gateway.exness.com",
      isDemo: config.isDemo !== undefined ? config.isDemo : process.env.EXN_IS_DEMO !== "false",
      dryRun: config.dryRun !== undefined ? config.dryRun : process.env.EXN_DRY_RUN === "true",
    };

    if (
      !this.config.apiKey ||
      !this.config.privateKey ||
      !this.config.accountId ||
      this.config.apiKey.includes("your_api_key") ||
      this.config.dryRun
    ) {
      this.isSimulationMode = true;
    } else {
      try {
        this.keyObject = loadEd25519Key(this.config.privateKey);
      } catch (err: any) {
        console.warn(`[EXNESS] Failed to load Ed25519 key: ${err.message}. Operating in sandbox simulation mode.`);
        this.isSimulationMode = true;
      }
    }
  }

  public isSimulated(): boolean {
    return this.isSimulationMode;
  }

  public isDemoAccount(): boolean {
    return this.config.isDemo;
  }

  /** Generates signed EXN-* authentication headers */
  public getSignedHeaders(
    method: string,
    pathWithQuery: string,
    bodyText = "",
    idempotency = "",
    customTs?: number
  ): Record<string, string> {
    const timestamp = customTs ?? Date.now();
    const idempotencyKey = method.toUpperCase() === "GET" ? "" : (idempotency || `ts-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`);
    const bodyHash = !bodyText
      ? "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
      : createHash("sha256").update(Buffer.from(bodyText, "utf8")).digest("base64url");

    const payloadObj = {
      api_key: this.config.apiKey,
      idempotency_key: idempotencyKey,
      timestamp,
      sign_version: 1,
      method: method.toUpperCase(),
      path: pathWithQuery,
      body_hash: bodyHash,
    };

    const payloadBytes = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const exnData = payloadBytes.toString("base64url");
    let exnSign = "";

    if (this.keyObject) {
      const signature = sign(null, payloadBytes, this.keyObject);
      exnSign = signature.toString("base64url");
    }

    return {
      "Content-Type": "application/json",
      "EXN-API-KEY": this.config.apiKey,
      "EXN-DATA": exnData,
      "EXN-SIGN": exnSign,
    };
  }

  /** Discovers and caches the specific trading server access point */
  private async getTradingBaseUrl(): Promise<string> {
    if (this.isSimulationMode) return "https://simulated.exness.local";
    const now = Date.now();
    if (this.accessPointUrl && now - this.accessPointCachedAt < 1800000) {
      return this.accessPointUrl;
    }

    const path = `/v1/trading/access-point?account_id=${this.config.accountId}`;
    const url = `${this.config.discoveryBaseUrl}${path}`;
    const headers = this.getSignedHeaders("GET", path);

    try {
      const resp = await fetch(url, { method: "GET", headers });
      if (!resp.ok) {
        throw new Error(`Discovery failed with status ${resp.status}`);
      }
      const data: any = await resp.json();
      const endpoint = data.access_point || data.endpoint || data.url;
      if (endpoint) {
        this.accessPointUrl = endpoint.replace(/\/+$/, "");
        this.accessPointCachedAt = now;
        return this.accessPointUrl!;
      }
    } catch (e: any) {
      // Fallback to direct api.exness-api.com
      return "https://api.exness-api.com";
    }
    return "https://api.exness-api.com";
  }

  /** Fetches current account equity and balance */
  public async getAccount(): Promise<ExnessAccountInfo> {
    if (this.isSimulationMode) {
      return {
        accountId: this.config.accountId || "SIM_GBPJPY_DEMO",
        balance: this.simBalance,
        equity: this.simBalance,
        freeMargin: this.simBalance,
        currency: "USD",
        isDemo: this.config.isDemo,
        isSimulated: true,
      };
    }

    const base = await this.getTradingBaseUrl();
    const path = `/v1/trading/accounts/${this.config.accountId}`;
    const headers = this.getSignedHeaders("GET", path);

    const resp = await fetch(`${base}${path}`, { method: "GET", headers });
    if (!resp.ok) {
      throw new Error(`Failed to fetch account info: ${resp.status} ${resp.statusText}`);
    }
    const d: any = await resp.json();
    return {
      accountId: String(d.account_id || this.config.accountId),
      balance: Number(d.balance || 0),
      equity: Number(d.equity || d.balance || 0),
      freeMargin: Number(d.free_margin || d.available_margin || d.balance || 0),
      currency: String(d.currency || "USD"),
      isDemo: this.config.isDemo,
      isSimulated: false,
    };
  }

  /** Fetches live quote for GBP/JPY or USD/JPY */
  public async getQuote(instrument = "GBPJPY"): Promise<ExnessQuote> {
    if (this.isSimulationMode) {
      return {
        instrument,
        bid: instrument === "USDJPY" ? 155.20 : 208.45,
        ask: instrument === "USDJPY" ? 155.22 : 208.48,
        timestamp: new Date().toISOString(),
      };
    }

    const base = await this.getTradingBaseUrl();
    const path = `/v1/market-data/quotes?instruments=${instrument}`;
    const headers = this.getSignedHeaders("GET", path);

    const resp = await fetch(`${base}${path}`, { method: "GET", headers });
    if (!resp.ok) {
      throw new Error(`Failed to get quote for ${instrument}: ${resp.status}`);
    }
    const res: any = await resp.json();
    const q = Array.isArray(res) ? res[0] : res[instrument] || res;
    return {
      instrument,
      bid: Number(q.bid || q.price || 0),
      ask: Number(q.ask || q.price || 0),
      timestamp: q.time || q.timestamp || new Date().toISOString(),
    };
  }

  /** Fetches live USD/JPY rate for precise JPY conversion */
  public async getLiveUsdJpyRate(): Promise<number> {
    try {
      const q = await this.getQuote("USDJPY");
      return (q.bid + q.ask) / 2.0;
    } catch {
      return 155.0; // Fallback conversion baseline if offline
    }
  }

  /** Fetches closed historical or live candlesticks from Exness */
  public async getCandles(timeframe: "M15" | "H1" | "D1", limit = 100): Promise<Candle[]> {
    if (this.isSimulationMode) {
      return [];
    }

    const base = await this.getTradingBaseUrl();
    const path = `/v1/market-data/candles?instrument=GBPJPY&timeframe=${timeframe}&limit=${limit}`;
    const headers = this.getSignedHeaders("GET", path);

    const resp = await fetch(`${base}${path}`, { method: "GET", headers });
    if (!resp.ok) {
      throw new Error(`Failed to get ${timeframe} candles: ${resp.status}`);
    }
    const list = (await resp.json()) as any[];
    return list.map((c) => ({
      open: Number(c.o ?? c.open),
      high: Number(c.h ?? c.high),
      low: Number(c.l ?? c.low),
      close: Number(c.c ?? c.close),
      time: c.t ?? c.time,
    }));
  }

  /** Submits a market order with attached SL and TP */
  public async openMarketOrder(req: ExnessOpenOrderRequest): Promise<ExnessOrderResponse> {
    const dirUpper = req.direction;
    const dirLower = dirUpper.toLowerCase();

    if (this.isSimulationMode) {
      const posId = `vpos_sim_${Date.now()}`;
      const fill = dirUpper === "BUY" ? 208.50 : 208.45;
      const pos: ExnessPositionItem = {
        positionId: posId,
        instrument: "GBPJPY",
        direction: dirUpper,
        volume: req.volume,
        openPrice: fill,
        sl: req.sl,
        tp: req.tp1,
        createTime: new Date().toISOString(),
        comment: req.comment || "TrendSweep_GBPJPY",
      };
      this.simPositions.set(posId, pos);

      return {
        success: true,
        orderId: `vord_${Date.now()}`,
        positionId: posId,
        direction: dirUpper,
        volume: req.volume,
        fillPrice: fill,
        sl: req.sl,
        tp: req.tp1,
        createTime: pos.createTime,
        isSimulated: true,
      };
    }

    const base = await this.getTradingBaseUrl();
    const path = "/v1/trading/orders";
    const body = {
      account_id: this.config.accountId,
      instrument: "GBPJPY",
      order_type: "market",
      direction: dirLower,
      volume: req.volume,
      take_profit: req.tp1,
      stop_loss: req.sl,
      comment: req.comment || "TrendSweep_GBPJPY",
    };
    const bodyJson = JSON.stringify(body);
    const headers = this.getSignedHeaders("POST", path, bodyJson);

    const resp = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: bodyJson,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        success: false,
        direction: dirUpper,
        volume: req.volume,
        fillPrice: 0,
        sl: req.sl,
        tp: req.tp1,
        createTime: new Date().toISOString(),
        error: `Order rejected (${resp.status}): ${errText}`,
      };
    }

    const res: any = await resp.json();
    return {
      success: true,
      orderId: String(res.order_id || res.id || ""),
      positionId: String(res.position_id || res.deal_id || res.order_id || ""),
      direction: dirUpper,
      volume: req.volume,
      fillPrice: Number(res.price || res.open_price || 0),
      sl: req.sl,
      tp: req.tp1,
      createTime: new Date().toISOString(),
      isSimulated: false,
    };
  }

  /** Modifies SL of an open position to Breakeven */
  public async modifyPositionSl(positionId: string, newSl: number): Promise<boolean> {
    if (this.isSimulationMode) {
      const p = this.simPositions.get(positionId);
      if (p) {
        p.sl = newSl;
        return true;
      }
      return false;
    }

    const base = await this.getTradingBaseUrl();
    const path = `/v1/trading/positions/${positionId}`;
    const bodyJson = JSON.stringify({ stop_loss: newSl });
    const headers = this.getSignedHeaders("PATCH", path, bodyJson);

    const resp = await fetch(`${base}${path}`, {
      method: "PATCH",
      headers,
      body: bodyJson,
    });
    return resp.ok;
  }

  /** Closes an open position partially or fully */
  public async closePosition(positionId: string, volume?: number): Promise<boolean> {
    if (this.isSimulationMode) {
      const p = this.simPositions.get(positionId);
      if (p) {
        if (volume && volume < p.volume) {
          p.volume = Number((p.volume - volume).toFixed(3));
        } else {
          this.simPositions.delete(positionId);
        }
        return true;
      }
      return false;
    }

    const base = await this.getTradingBaseUrl();
    const path = `/v1/trading/positions/${positionId}/close`;
    const bodyJson = volume ? JSON.stringify({ volume }) : "{}";
    const headers = this.getSignedHeaders("POST", path, bodyJson);

    const resp = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: bodyJson,
    });
    return resp.ok;
  }

  /** Retrieves currently active positions on GBP/JPY */
  public async getOpenPositions(): Promise<ExnessPositionItem[]> {
    if (this.isSimulationMode) {
      return Array.from(this.simPositions.values());
    }

    const base = await this.getTradingBaseUrl();
    const path = `/v1/trading/positions?account_id=${this.config.accountId}&instrument=GBPJPY`;
    const headers = this.getSignedHeaders("GET", path);

    const resp = await fetch(`${base}${path}`, { method: "GET", headers });
    if (!resp.ok) return [];
    const list = (await resp.json()) as any[];
    return list.map((p) => ({
      positionId: String(p.position_id || p.id),
      instrument: String(p.instrument || "GBPJPY"),
      direction: String(p.direction).toUpperCase() as "BUY" | "SELL",
      volume: Number(p.volume || 0),
      openPrice: Number(p.open_price || p.price || 0),
      sl: Number(p.stop_loss || 0),
      tp: Number(p.take_profit || 0),
      currentPrice: Number(p.current_price || 0),
      profit: Number(p.profit || 0),
      createTime: p.create_time || new Date().toISOString(),
      comment: p.comment,
    }));
  }
}
