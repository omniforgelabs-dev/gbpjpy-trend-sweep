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
  gatewayHost: string;
  discoveryBaseUrl?: string;
  accessPointUrl?: string;
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
  sltpOrderId?: string;
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
    const rawGateway =
      config.gatewayHost ||
      process.env.EXN_GATEWAY_HOST ||
      config.discoveryBaseUrl ||
      process.env.EXN_DISCOVERY_BASE_URL ||
      "https://api.exness-api.com";

    const rawAccessPoint =
      config.accessPointUrl ||
      process.env.EXN_ACCESS_POINT_URL ||
      "";

    this.config = {
      apiKey: config.apiKey || process.env.EXN_API_KEY || "",
      privateKey: config.privateKey || process.env.EXN_PRIVATE_KEY || "",
      accountId: config.accountId || process.env.EXN_ACCOUNT_ID || "",
      gatewayHost: this.normalizeUrl(rawGateway),
      discoveryBaseUrl: this.normalizeUrl(rawGateway),
      accessPointUrl: rawAccessPoint ? this.normalizeUrl(rawAccessPoint) : undefined,
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

  public normalizeUrl(url: string): string {
    let u = url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(u)) {
      u = `https://${u}`;
    }
    return u;
  }

  public getConfiguredGatewayHost(): string {
    return this.config.gatewayHost;
  }

  public getResolvedAccessPoint(): string | null {
    return this.accessPointUrl;
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
      "User-Agent": "ApexTradingSystem/1.0",
      "EXN-API-KEY": this.config.apiKey,
      "EXN-IDEMPOTENCY-KEY": idempotencyKey,
      "EXN-TIMESTAMP": String(timestamp),
      "EXN-SIGN-VERSION": "1",
      "EXN-DATA": exnData,
      "EXN-SIGN": exnSign,
    };
  }

  /**
   * Resolves and caches the account-specific Access Point from the Gateway host.
   * Accepts the actual Gateway host from Exness API Key Management DNS widget,
   * queries GET /v1/trading/access-point?account_id=<ID>, and falls back seamlessly if needed.
   */
  public async getTradingBaseUrl(forceRefresh = false): Promise<string> {
    if (this.isSimulationMode) return "https://simulated.exness.local";

    // Direct override if user provided EXN_ACCESS_POINT_URL directly
    if (this.config.accessPointUrl) {
      return this.config.accessPointUrl;
    }

    const now = Date.now();
    // Cache Access Point for 60 minutes
    if (!forceRefresh && this.accessPointUrl && now - this.accessPointCachedAt < 3600000) {
      return this.accessPointUrl;
    }

    const path = `/v1/trading/access-point?account_id=${this.config.accountId}`;

    // Candidate Gateway hosts: User-configured gateway host first, then known live gateways
    const candidates = [
      this.config.gatewayHost,
      "https://api.exness-api.com",
      "https://api.exness.com",
    ].filter(Boolean).map((h) => this.normalizeUrl(h));

    const uniqueCandidates = Array.from(new Set(candidates));

    for (const gateway of uniqueCandidates) {
      try {
        const url = `${gateway}${path}`;
        const headers = this.getSignedHeaders("GET", path);

        const resp = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15000) });
        if (resp.ok) {
          const data: any = await resp.json();
          const endpoint = data.access_point || data.accessPoint || data.endpoint || data.url || data.data?.access_point;
          if (endpoint && typeof endpoint === "string") {
            this.accessPointUrl = this.normalizeUrl(endpoint);
            this.accessPointCachedAt = now;
            console.log(`[EXNESS] Account-specific Access Point discovered: ${this.accessPointUrl} (via Gateway: ${gateway})`);
            return this.accessPointUrl;
          }
        } else {
          const errText = await resp.text().catch(() => "");
          console.warn(`[EXNESS] Gateway ${gateway} returned status ${resp.status} for access-point discovery: ${errText}`);
        }
      } catch (err: any) {
        console.warn(`[EXNESS] Gateway ${gateway} access-point request error: ${err.message}`);
      }
    }

    // Default fallback to api.exness-api.com
    const fallback = this.config.gatewayHost || "https://api.exness-api.com";
    this.accessPointUrl = this.normalizeUrl(fallback);
    this.accessPointCachedAt = now;
    console.warn(`[EXNESS] Access Point discovery exhausted candidates. Using fallback trading endpoint: ${this.accessPointUrl}`);
    return this.accessPointUrl;
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
    const path = `/v1/trading/accounts/${this.config.accountId}/snapshot`;
    const headers = this.getSignedHeaders("GET", path);

    const resp = await fetch(`${base}${path}`, { method: "GET", headers });
    if (!resp.ok) {
      const altPath = `/v1/trading/accounts/${this.config.accountId}`;
      const altResp = await fetch(`${base}${altPath}`, { method: "GET", headers: this.getSignedHeaders("GET", altPath) });
      if (!altResp.ok) {
        throw new Error(`Failed to fetch account info: ${resp.status} ${resp.statusText}`);
      }
      const altData: any = await altResp.json();
      return {
        accountId: String(this.config.accountId),
        balance: Number(altData.balance || 0),
        equity: Number(altData.equity || altData.balance || 0),
        freeMargin: Number(altData.free_margin || altData.balance || 0),
        currency: String(altData.currency || "USD"),
        isDemo: this.config.isDemo,
        isSimulated: false,
      };
    }
    const d: any = await resp.json();
    const acc = d.account_state || d;
    return {
      accountId: String(this.config.accountId),
      balance: Number(acc.balance || 0),
      equity: Number(acc.equity || acc.balance || 0),
      freeMargin: Number(acc.free_margin || (Number(acc.equity || 0) - Number(acc.used_margin || 0)) || acc.balance || 0),
      currency: String(acc.currency || "USD"),
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
    const nowIso = new Date().toISOString();

    // 1. Try high-frequency M1 candle close from market-data API
    try {
      const candlePath = `/v1/market-data/accounts/${this.config.accountId}/candles?instrument=${instrument}&timeframe=M1&from=${encodeURIComponent(nowIso)}&count=-1&price_type=bid`;
      const candleHeaders = this.getSignedHeaders("GET", candlePath);
      const candleResp = await fetch(`${base}${candlePath}`, { method: "GET", headers: candleHeaders });
      if (candleResp.ok) {
        const cData: any = await candleResp.json();
        const candles = cData.candles || [];
        if (candles.length > 0) {
          const latest = candles[candles.length - 1];
          const spread = instrument === "USDJPY" ? 0.02 : 0.03;
          const bid = Number(latest.c || latest.close || 0);
          return {
            instrument,
            bid,
            ask: Number((bid + spread).toFixed(3)),
            timestamp: latest.t || latest.time || nowIso,
          };
        }
      }
    } catch {
      // Continue to quotes fallback
    }

    // 2. Direct quotes fallback
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
    const nowIso = new Date().toISOString();
    const path = `/v1/market-data/accounts/${this.config.accountId}/candles?instrument=GBPJPY&timeframe=${timeframe}&from=${encodeURIComponent(nowIso)}&count=${-Math.abs(limit)}&price_type=bid`;
    const headers = this.getSignedHeaders("GET", path);

    const resp = await fetch(`${base}${path}`, { method: "GET", headers });
    if (!resp.ok) {
      // Alternate candles endpoint fallback
      const altPath = `/v1/market-data/candles?instrument=GBPJPY&timeframe=${timeframe}&limit=${limit}`;
      const altResp = await fetch(`${base}${altPath}`, { method: "GET", headers: this.getSignedHeaders("GET", altPath) });
      if (!altResp.ok) {
        throw new Error(`Failed to get ${timeframe} candles: ${resp.status}`);
      }
      const altList = (await altResp.json()) as any[];
      return altList.map((c) => ({
        open: Number(c.o ?? c.open),
        high: Number(c.h ?? c.high),
        low: Number(c.l ?? c.low),
        close: Number(c.c ?? c.close),
        time: c.t ?? c.time,
      }));
    }

    const data: any = await resp.json();
    const list: any[] = data.candles || (Array.isArray(data) ? data : []);
    const candles: Candle[] = list.map((c) => ({
      open: Number(c.o ?? c.open),
      high: Number(c.h ?? c.high),
      low: Number(c.l ?? c.low),
      close: Number(c.c ?? c.close),
      time: c.t ?? c.time,
    }));
    // Sort oldest first
    candles.sort((a, b) => new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime());
    return candles;
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
    const path = `/v1/trading/accounts/${this.config.accountId}/positions`;
    const body: Record<string, any> = {
      instrument: "GBPJPY",
      side: dirLower,
      volume: req.volume.toFixed(2),
      comment: req.comment || "TrendSweep_GBPJPY",
    };
    if (req.sl > 0) body.stop_loss_price = req.sl.toFixed(3);
    if (req.tp1 > 0) body.take_profit_price = req.tp1.toFixed(3);

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
    const opId = String(res.operation_id || res.id || "");
    let positionId = String(res.position_id || opId);
    let fillPrice = Number(res.price || res.open_price || 0);

    // Retrieve confirmed position from snapshot if only ACK / operation_id was returned
    if (!fillPrice || fillPrice === 0) {
      try {
        const positions = await this.getOpenPositions();
        const matched = positions.find((p) => p.direction === dirUpper);
        if (matched) {
          positionId = matched.positionId;
          fillPrice = matched.openPrice;
        }
      } catch {}
    }

    return {
      success: true,
      orderId: opId,
      positionId,
      direction: dirUpper,
      volume: req.volume,
      fillPrice: fillPrice || (dirUpper === "BUY" ? 208.50 : 208.45),
      sl: req.sl,
      tp: req.tp1,
      createTime: new Date().toISOString(),
      isSimulated: false,
    };
  }

  /** Modifies SL of an open position to Breakeven */
  public async modifyPositionSl(positionId: string, newSl: number, sltpOrderId?: string): Promise<boolean> {
    if (this.isSimulationMode) {
      const p = this.simPositions.get(positionId);
      if (p) {
        p.sl = newSl;
        return true;
      }
      return false;
    }

    const base = await this.getTradingBaseUrl();

    // 1. If sltpOrderId known or discoverable, PATCH existing sltp order
    let targetSltpId = sltpOrderId;
    if (!targetSltpId) {
      try {
        const open = await this.getOpenPositions();
        const match = open.find((p) => p.positionId === positionId);
        targetSltpId = match?.sltpOrderId;
      } catch {}
    }

    if (targetSltpId) {
      const path = `/v1/trading/accounts/${this.config.accountId}/orders/${targetSltpId}`;
      const body = JSON.stringify({ stop_loss_price: newSl.toFixed(3) });
      const headers = this.getSignedHeaders("PATCH", path, body);
      const resp = await fetch(`${base}${path}`, { method: "PATCH", headers, body });
      if (resp.ok) return true;
    }

    // 2. Attach new sltp order via POST /orders
    try {
      const path = `/v1/trading/accounts/${this.config.accountId}/orders`;
      const body = JSON.stringify({
        type: "sltp",
        position_id: positionId,
        stop_loss_price: newSl.toFixed(3),
      });
      const headers = this.getSignedHeaders("POST", path, body);
      const resp = await fetch(`${base}${path}`, { method: "POST", headers, body });
      if (resp.ok) return true;
    } catch {}

    // 3. Fallback to direct position PATCH
    try {
      const path = `/v1/trading/positions/${positionId}`;
      const body = JSON.stringify({ stop_loss: newSl });
      const headers = this.getSignedHeaders("PATCH", path, body);
      const resp = await fetch(`${base}${path}`, { method: "PATCH", headers, body });
      return resp.ok;
    } catch {
      return false;
    }
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

    // 1. Authoritative DELETE /positions/{id}?volume=...
    let delPath = `/v1/trading/accounts/${this.config.accountId}/positions/${positionId}`;
    if (volume && volume > 0) {
      delPath += `?volume=${volume.toFixed(2)}`;
    }
    const delHeaders = this.getSignedHeaders("DELETE", delPath);
    const delResp = await fetch(`${base}${delPath}`, { method: "DELETE", headers: delHeaders });
    if (delResp.ok) return true;

    // 2. Fallback to POST /positions/{id}/close
    try {
      const postPath = `/v1/trading/positions/${positionId}/close`;
      const bodyJson = volume ? JSON.stringify({ volume }) : "{}";
      const headers = this.getSignedHeaders("POST", postPath, bodyJson);
      const postResp = await fetch(`${base}${postPath}`, { method: "POST", headers, body: bodyJson });
      return postResp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Retrieves currently active GBP/JPY positions and reconciles with attached SL/TP orders from snapshot.
   */
  public async getOpenPositions(): Promise<ExnessPositionItem[]> {
    if (this.isSimulationMode) {
      return Array.from(this.simPositions.values());
    }

    const base = await this.getTradingBaseUrl();
    const path = `/v1/trading/accounts/${this.config.accountId}/snapshot`;
    const headers = this.getSignedHeaders("GET", path);

    const resp = await fetch(`${base}${path}`, { method: "GET", headers });
    if (!resp.ok) {
      // Fallback to /positions endpoint if snapshot unavailable
      const altPath = `/v1/trading/positions?account_id=${this.config.accountId}&instrument=GBPJPY`;
      const altResp = await fetch(`${base}${altPath}`, { method: "GET", headers: this.getSignedHeaders("GET", altPath) });
      if (!altResp.ok) return [];
      const list = (await altResp.json()) as any[];
      return list.map((p) => ({
        positionId: String(p.position_id || p.id),
        instrument: "GBPJPY",
        direction: String(p.direction || p.side || "BUY").toUpperCase() as "BUY" | "SELL",
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

    const data: any = await resp.json();
    const orders: any[] = data.orders || [];
    const positions: any[] = data.positions || [];

    // Map attached sltp orders by position_id
    const sltpOrdersByPosId = new Map<string, any>();
    for (const ord of orders) {
      if ((ord.order_type === "sltp" || ord.type === "sltp") && ord.position_id) {
        sltpOrdersByPosId.set(String(ord.position_id), ord);
      }
    }

    return positions
      .filter((p: any) => !p.instrument || p.instrument.replace("/", "") === "GBPJPY")
      .map((p: any) => {
        const posId = String(p.position_id || p.id);
        const sltp = sltpOrdersByPosId.get(posId);
        const dir = String(p.direction || p.side || "buy").toUpperCase() as "BUY" | "SELL";
        const openPrice = Number(p.open_price || p.price || 0);
        const sl = sltp ? Number(sltp.stop_loss_price || sltp.stop_loss || 0) : Number(p.stop_loss || 0);
        const tp = sltp ? Number(sltp.take_profit_price || sltp.take_profit || 0) : Number(p.take_profit || 0);

        return {
          positionId: posId,
          instrument: "GBPJPY",
          direction: dir,
          volume: Number(p.volume || 0),
          openPrice,
          sl,
          tp,
          currentPrice: Number(p.current_price || p.price || openPrice),
          profit: Number(p.profit || p.upl || 0),
          createTime: p.create_time || new Date().toISOString(),
          comment: p.comment,
          sltpOrderId: sltp ? String(sltp.order_id || sltp.id) : undefined,
        };
      });
  }
}
