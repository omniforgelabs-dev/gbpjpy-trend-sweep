/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST SUITE: EXNESS TRADING API CLIENT & SIGNING
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { ExnessClient, loadEd25519Key } from "../src/broker/exnessClient.js";

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

async function runTests(): Promise<void> {
  console.log("\n=== Exness Client & Signing Verification ===");

  // 1. Official RFC 8032 Ed25519 Test Vector Verification
  {
    const testHex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const key = loadEd25519Key(testHex);
    assert(key !== null && key.asymmetricKeyType === "ed25519", "1a. Successfully loaded RFC 8032 Ed25519 test key");

    const timestamp = 1773656070123;
    const apiKey = "exnsk-synthetic-example";
    const path = "/v1/trading/access-point?account_id=123456";
    const method = "GET";

    const client = new ExnessClient({
      apiKey,
      privateKey: testHex,
      accountId: "123456",
    });

    const headers = client.getSignedHeaders(method, path, "", "", timestamp);

    const expectedData = "eyJhcGlfa2V5IjoiZXhuc2stc3ludGhldGljLWV4YW1wbGUiLCJpZGVtcG90ZW5jeV9rZXkiOiIiLCJ0aW1lc3RhbXAiOjE3NzM2NTYwNzAxMjMsInNpZ25fdmVyc2lvbiI6MSwibWV0aG9kIjoiR0VUIiwicGF0aCI6Ii92MS90cmFkaW5nL2FjY2Vzcy1wb2ludD9hY2NvdW50X2lkPTEyMzQ1NiIsImJvZHlfaGFzaCI6IjQ3REVRcGo4SEJTYS1fVEltVy01SkNldVFlUmttNU5NcEpXWkczaFN1RlUifQ";
    const expectedSign = "l-H_Acia8YoTjKFMg-3fon3NOEX8TalNVA7c01DQ9dHb7pVBJC4y06qC-DbpETzh1KToiOprqEV6uzN3t69ICQ";

    assert(headers["EXN-DATA"] === expectedData, "1b. EXN-DATA payload matches official Exness Developer Portal specification");
    assert(headers["EXN-SIGN"] === expectedSign, "1c. RFC 8032 Ed25519 signature perfectly verified against Exness reference");
  }

  // 2. Demo vs Live Configuration Switch
  {
    const demoClient = new ExnessClient({
      isDemo: true,
      dryRun: true,
    });
    assert(demoClient.isDemoAccount() === true, "2a. Demo configuration flag correctly detected");

    const liveClient = new ExnessClient({
      isDemo: false,
      dryRun: true,
    });
    assert(liveClient.isDemoAccount() === false, "2b. Live configuration flag correctly detected");
  }

  // 3. Execution Engine Selection: Real Demo vs Simulation Mode
  {
    const testHex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

    // When valid credentials and dryRun=false are provided, real Exness REST API is activated
    const realDemoClient = new ExnessClient({
      apiKey: "exnsk-valid-key",
      privateKey: testHex,
      accountId: "12345678",
      isDemo: true,
      dryRun: false,
    });
    assert(realDemoClient.isSimulated() === false, "3a. Real credentials activate authentic Exness REST API mode (isSimulated=false)");
    assert(realDemoClient.isDemoAccount() === true, "3b. Mode is genuine Exness Demo");

    // When credentials are placeholders or dryRun=true, fallback to simulation occurs
    const simClient = new ExnessClient({
      apiKey: "exnsk-your_api_key",
      dryRun: true,
    });
    assert(simClient.isSimulated() === true, "3c. Placeholder or dry-run activates sandbox simulation");
  }

  // 4. Sandbox / Simulation Behavior & Order Lifecycle
  {
    const simClient = new ExnessClient({ dryRun: true });

    // Account fetch
    const acc = await simClient.getAccount();
    assert(acc.balance === 10.0, `4a. Starting simulated balance is $10 (got $${acc.balance})`);

    // Order execution
    const res = await simClient.openMarketOrder({
      direction: "BUY",
      volume: 0.001,
      sl: 208.10,
      tp1: 208.80,
    });
    assert(res.success === true, "4b. Simulated order placement succeeds");
    assert(res.positionId !== undefined, "4c. Position ID assigned");

    // Position check
    const open = await simClient.getOpenPositions();
    assert(open.length === 1, `4d. Position recorded in broker open positions (count: ${open.length})`);
    assert(open[0].sl === 208.10, `4e. Stop Loss preserved (got ${open[0].sl})`);
    assert(open[0].tp === 208.80, `4f. Take Profit preserved (got ${open[0].tp})`);

    // Modify SL to Breakeven
    const modOk = await simClient.modifyPositionSl(open[0].positionId, 208.50);
    assert(modOk === true, "4g. Stop Loss modification to Breakeven succeeds");
    const openAfterMod = await simClient.getOpenPositions();
    assert(openAfterMod[0].sl === 208.50, `4h. SL successfully updated to entry (got ${openAfterMod[0].sl})`);

    // Partial close 50%
    const closeOk = await simClient.closePosition(open[0].positionId, 0.0005);
    assert(closeOk === true, "4i. Partial position close succeeds");
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
