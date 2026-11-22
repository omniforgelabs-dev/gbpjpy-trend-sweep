# GBP/JPY Trend Sweep Automated Trading Bot

A completely independent, lightweight, headless automated trading bot for **GBP/JPY** running the original **Trend-Following Liquidity Sweep with Momentum Rejection (Trend Sweep 🌊, Option A)** strategy recovered from the APEX quant research archive.

Directly integrated with the **Exness Trading API v1.0.2** using native RFC 8032 Ed25519 request signing. Built with a built-in HTTP health check endpoint (`/health`) designed for deployment on **Render's Free Web Service plan**.

---

## 1. Preserved Strategy Rules (100% Original Logic)

This bot executes the exact zero-lookahead specification recovered from `trendSweep.ts`:

1. **Asset**: Strictly **GBP/JPY** only (Pip size: 0.01, standard point digits: 3).
2. **Macro Trend Filter (Zero-Lookahead Completed H1 Bars)**:
   - Uses only completed H1 candles (`timestamp <= m15_time - 3600s`).
   - **Bullish Trend (BUY only)**: H1 EMA(10) > H1 EMA(20) AND Completed H1 Close > H1 EMA(10).
   - **Bearish Trend (SELL only)**: H1 EMA(10) < H1 EMA(20) AND Completed H1 Close < H1 EMA(10).
   - Neutral or counter-trend setups are strictly rejected.
3. **Session Window**:
   - **Weekdays (Monday–Friday) 08:00 to 15:00 UTC** (09:00 to 16:00 WAT).
   - Off-hours and weekends are locked out.
4. **M15 Micro Liquidity Sweep & Momentum Rejection**:
   - **Lookback**: Prior 20 M15 bars (prior 5 hours of structural price action).
   - **BUY**: M15 candle sweeps below the 20-bar low (`low < priorLow`), closes back above it (`close > priorLow`), closing bullish (`close > open`).
   - **SELL**: M15 candle sweeps above the 20-bar high (`high > priorHigh`), closes back below it (`close < priorHigh`), closing bearish (`close < open`).
   - **Candle Rejection Quality**: Solid body $\ge 40\%$ of candle range OR institutional pin-bar rejection wick $\ge 40\%$.
5. **Stop Loss & Scaled Targets**:
   - **Stop Loss**: Anchored at sweep extreme $\pm 1.2 \times \text{M15 ATR}(14)$, floored at $\min = 0.3 \times \text{ATR}(14)$.
   - **Target 1 (50% position)**: $1.00\text{R}$. When hit, closes 50% volume and moves SL to Breakeven ($+0.50\text{R}$ locked).
   - **Target 2 (50% runner)**: $2.50\text{R}$ (or Daily R1/S1 settlement pivot if offering $\ge 1.50\text{R}$).
   - **Staleness Exit**: If trade makes $< 0\text{R}$ progress after 8 hours (32 M15 bars), it is closed automatically.

---

## 2. Dynamic Position Sizing & Micro Account Risk

- **Account Balance Target**: ~$10 USD starting capital.
- **Intended Starting Lot**: `0.001` lots (subject to broker `volumeMin`).
- **Maximum Intended Risk**: `$1.00` USD per trade (configurable via `MAX_RISK_USD`).
- **Lower R:R Proportional Risk Scaling**: If a setup presents a lower reward-to-risk ratio (e.g. $0.6\text{–}0.9\text{R}$), the bot reduces the dollar risk proportionally rather than rejecting the trade.
- **Preservation of Levels**: The bot calculates lot size from the actual stop distance and exchange conversion rate. It **never modifies or tightens the original stop loss** just to fit an arbitrary dollar amount.

---

## 3. Minimal HTTP Health Endpoint (`/health`)

To deploy on **Render's Free Web Service plan**, the bot runs a zero-overhead native HTTP server on `0.0.0.0:${PORT}` alongside the trading cycle:

- **Endpoint**: `GET /health` (or `/` or `/healthz`)
- **Response**: HTTP 200 with status JSON:
  ```json
  {
    "status": "healthy",
    "service": "gbpjpy-trend-sweep",
    "pair": "GBP/JPY",
    "mode": "demo",
    "executionEngine": "simulation",
    "uptimeSeconds": 120,
    "activeTrade": false,
    "activeTradeId": null,
    "lastHeartbeat": "2026-11-22T23:15:00.000Z",
    "timestamp": "2026-11-22T23:15:10.000Z"
  }
  ```
- **Safety Guarantee**: The health server is strictly read-only; it does not execute orders, alter positions, or affect strategy logic.
- **Graceful Shutdown**: Shuts down cleanly on SIGTERM/SIGINT alongside the trading loop.

---

## 4. Render Free Web Service Deployment Instructions

### Step 1: Create Free Web Service
1. Log into your [Render Dashboard](https://dashboard.render.com/).
2. Click **New +** $\rightarrow$ **Web Service**.
3. Connect your repository: **`omniforgelabs-dev/gbpjpy-trend-sweep`**.

### Step 2: Configure Service Settings
- **Name**: `gbpjpy-trend-sweep`
- **Region**: Frankfurt (EU Central) or London (closest to Exness servers).
- **Branch**: `main`
- **Runtime**: `Node`
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm run start:prod`
- **Instance Type / Plan**: **`Free`**
- **Health Check Path**: `/health` (Under Advanced $\rightarrow$ Health Check Path).

### Step 3: Enter Environment Variables
In the **Environment Variables** section, enter:

| Variable Name | Value | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Production runtime. |
| `EXN_IS_DEMO` | `true` | `true` for Demo; `false` for Live. |
| `EXN_ACCOUNT_ID` | `your_demo_account` | Your Exness Demo account number. |
| `EXN_API_KEY` | `exnsk-your_api_key` | Your Exness API key. |
| `EXN_PRIVATE_KEY` | `your_128_hex_key` | Your Ed25519 128-hex private key or PKCS#8 PEM string. |
| `EXN_GATEWAY_HOST` | `https://api.exness-api.com` | Gateway host from your Exness API Key Management DNS widget. |
| `MAX_RISK_USD` | `1.00` | Max intended risk per trade ($1.00 USD). |
| `POLL_INTERVAL_MS` | `60000` | Scanner cycle interval (60 seconds). |
| `EXN_DRY_RUN` | `false` | Real broker execution. |

Click **Create Web Service**. Render will build and deploy the service.

---

## 5. Keeping Render Free Web Service Awake 24/7

Render's Free Web Services spin down into sleep mode if they do not receive inbound HTTP traffic for 15 minutes.

To keep the bot active and scanning continuously 24/7 during market hours:
1. Copy your deployed Render public URL:
   `https://<your-service-name>.onrender.com/health`
2. Create a free monitor at [UptimeRobot](https://uptimerobot.com/) or [cron-job.org](https://cron-job.org/):
   - **Monitor Type**: HTTP(s)
   - **URL**: `https://<your-service-name>.onrender.com/health`
   - **Monitoring Interval**: Every 5 or 10 minutes.
3. Every ping receives an HTTP 200 response, keeping your free Render container awake and trading non-stop!

---

## 6. How to Switch from Demo to Live (After 5–6 Days)

**No code rebuild or development work is required.**

When you finish your 5–6 days of Demo testing:
1. Open your **Render Dashboard** $\rightarrow$ select `gbpjpy-trend-sweep`.
2. Go to the **Environment** tab.
3. Update only these variables:
   - **`EXN_IS_DEMO`**: Change from `true` to **`false`**.
   - **`EXN_ACCOUNT_ID`**: Change to your **real Exness Live account number**.
   - **`EXN_API_KEY`** & **`EXN_PRIVATE_KEY`**: Set to your Live Exness API credentials.
   - **`EXN_GATEWAY_HOST`**: Set to your Live Gateway host (from your Live DNS widget).
4. Click **Save Changes**.

Render will automatically restart the Web Service. The bot will wake up, discover the Live Access Point, connect to your Live Exness account, and manage real capital with the exact same strategy and risk logic.

---

## 7. Local Testing & Verification

Run all test suites locally:

```bash
# Run all 62 automated verification tests
npm test

# Run individual suites
npm run test:strategy      # Strategy logic & zero-lookahead (14 tests)
npm run test:risk          # Dynamic position sizing & lower R:R scaling (13 tests)
npm run test:broker        # Exness RFC 8032 Ed25519 signing (6 tests)
npm run test:integration   # Crash recovery, deduplication, & lifecycle (20 tests)
npm run test:health        # Minimal HTTP health endpoint & shutdown (9 tests)
```
