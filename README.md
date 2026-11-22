# GBP/JPY Trend Sweep Automated Trading Bot

A completely independent, lightweight, headless automated trading bot for **GBP/JPY** running the original **Trend-Following Liquidity Sweep with Momentum Rejection (Trend Sweep 🌊, Option A)** strategy recovered from the APEX quant research archive.

Directly integrated with the **Exness Trading API v1.0.2** using native RFC 8032 Ed25519 request signing. Designed for deployment as a 24/7 background worker on **Render**.

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

## 3. Project Architecture

```
gbpjpy-trend-sweep/
├── src/
│   ├── strategy/
│   │   └── trendSweep.ts       # Original zero-lookahead Trend Sweep engine
│   ├── broker/
│   │   └── exnessClient.ts     # Exness Trading API v1.0.2 direct client (Ed25519 signing)
│   ├── risk/
│   │   └── positionSizer.ts    # Dynamic lot sizer ($1.00 max risk, JPY conversion)
│   ├── state/
│   │   └── stateManager.ts     # Crash-resistant atomic disk persistence & deduplication
│   └── bot.ts                  # Autonomous headless daemon & trade lifecycle manager
├── test/
│   ├── trendSweep.test.ts      # Strategy unit tests & historical data replay
│   ├── positionSizer.test.ts   # Position sizing & lower R:R scaling tests
│   ├── exnessClient.test.ts    # RFC 8032 Ed25519 signature test vector verification
│   ├── botIntegration.test.ts  # Restart recovery, deduplication, & lifecycle tests
│   └── runAllTests.ts          # Unified test runner (53/53 tests passing)
├── render.yaml                 # Render Blueprint configuration
├── Dockerfile                  # Lightweight Node.js 20 Alpine container
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## 4. Render Deployment Instructions (Background Worker)

### Option A: 1-Click Blueprint Deploy (Recommended)

1. Push this repository to GitHub: `https://github.com/<your-username>/gbpjpy-trend-sweep`.
2. Log into [Render Dashboard](https://dashboard.render.com/).
3. Click **New +** $\rightarrow$ **Blueprint**.
4. Connect the `gbpjpy-trend-sweep` repository. Render will automatically read `render.yaml`.
5. Enter your Exness API credentials under Environment Variables and deploy!

### Option B: Manual Background Worker Setup

1. In Render Dashboard, click **New +** $\rightarrow$ **Background Worker**.
2. Select your `gbpjpy-trend-sweep` GitHub repository.
3. Configure settings:
   - **Name**: `gbpjpy-trend-sweep`
   - **Region**: Closest to your broker (e.g., Frankfurt or London for lowest latency).
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm run start:prod`
   - **Plan**: `Starter` (or higher for 24/7 persistent execution)
4. Add the **Environment Variables** (see table below).
5. Click **Create Background Worker**.

---

## 5. Required Environment Variables

Configure these in **Render Dashboard** $\rightarrow$ **Service** $\rightarrow$ **Environment**:

| Variable Name | Example / Default | Description |
| :--- | :--- | :--- |
| `EXN_API_KEY` | `exnsk-your_api_key_here` | Your Exness Trading API Key. |
| `EXN_PRIVATE_KEY` | `your_128_hex_key_or_pem` | Your Ed25519 128-hex private key or PKCS#8 PEM string. |
| `EXN_ACCOUNT_ID` | `12345678` | Your Exness Demo or Live Account Number. |
| `EXN_DISCOVERY_BASE_URL` | `https://gateway.exness.com` | Exness API Gateway Access Point discovery URL. |
| `EXN_IS_DEMO` | `true` | Set to `true` for Demo; set to `false` for Live. |
| `MAX_RISK_USD` | `1.00` | Maximum intended risk per trade in USD (e.g., $1.00 for $10 balance). |
| `POLL_INTERVAL_MS` | `60000` | Scanner loop interval in milliseconds (60,000 = 60s). |
| `EXN_DRY_RUN` | `false` | Set to `true` for local sandbox simulation without placing broker orders. |

---

## 6. How to Switch from Demo to Live (After 5–6 Days)

**No code rebuild or development work is required to switch to Live.**

When you finish your 5–6 days of Demo testing:

1. Open your **Render Dashboard** $\rightarrow$ select `gbpjpy-trend-sweep`.
2. Go to the **Environment** tab.
3. Update only these variables:
   - **`EXN_IS_DEMO`**: Change from `true` to `false`.
   - **`EXN_ACCOUNT_ID`**: Change to your real Exness Live account number.
   - **`EXN_API_KEY`** & **`EXN_PRIVATE_KEY`**: Set to your Live Exness API credentials (if different from Demo).
4. Click **Save Changes**.

Render will automatically restart the worker. The bot will connect directly to your Live Exness account using the identical strategy, sizing, and risk rules.

---

## 7. Local Testing & Verification

Run all test suites locally:

```bash
# Run all 53 automated verification tests
npm test

# Run individual suites
npm run test:strategy      # Strategy logic & zero-lookahead
npm run test:risk          # Dynamic position sizing & lower R:R scaling
npm run test:broker        # Exness RFC 8032 Ed25519 signing
npm run test:integration   # Crash recovery, deduplication, & lifecycle
```
