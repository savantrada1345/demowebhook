import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Allow local self-signed certs during testing
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const certPath = path.join(__dirname, "../certs/cert.pem");
const isHttpsEnabled = fs.existsSync(certPath);
const envPath = path.join(__dirname, "../.env");
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(envPath);
  } catch {}
}

const defaultProtocol = isHttpsEnabled ? "https" : "http";
const port = process.env.PORT || "5055";
const TARGET_URL =
  process.env.TARGET_URL ||
  `${defaultProtocol}://127.0.0.1:${port}/webhooks/altis`;
const BASE_URL = TARGET_URL.replace("/webhooks/altis", "");
const SECRET =
  "whsec_358fd5ca24188064f8f478f5b4ab450c07b32ffed678ff2f3d6ccbe0bf991fd1";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function signPayload(secret, timestamp, body) {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `sha256=${digest}`;
}

async function sendWebhook({
  payload,
  secret = SECRET,
  timestamp = null,
  headers = {},
}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const ts =
    timestamp !== null ? timestamp : Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(secret, ts, body);

  const finalHeaders = {
    "Content-Type": "application/json",
    "User-Agent": "Altis-Webhooks/1.0",
    "X-Altis-Timestamp": ts,
    "X-Altis-Signature": signature,
    ...headers,
  };

  const response = await fetch(TARGET_URL, {
    method: "POST",
    headers: finalHeaders,
    body,
  });

  const responseText = await response.text();
  let json = null;
  try {
    json = JSON.parse(responseText);
  } catch {
    json = null;
  }

  return {
    status: response.status,
    text: responseText,
    json,
  };
}

async function runTests() {
  console.log(
    `\n${colors.bold}${colors.cyan}═════════════════════════════════════════════════════════════════════${colors.reset}`,
  );
  console.log(
    `${colors.bold}${colors.cyan}   HALO OUTBOUND WEBHOOK SIMULATION & COMPLIANCE TEST SUITE          ${colors.reset}`,
  );
  console.log(
    `${colors.bold}${colors.cyan}═════════════════════════════════════════════════════════════════════${colors.reset}\n`,
  );
  console.log(`Target endpoint: ${colors.yellow}${TARGET_URL}${colors.reset}`);
  console.log(
    `Using secret:    ${colors.dim}${SECRET.slice(0, 10)}...${colors.reset}\n`,
  );

  // Check if receiver is reachable, otherwise start it in-process
  let inProcessServer = null;
  try {
    const health = await fetch(`${BASE_URL}/api/health`).then((r) => r.json());
    console.log(
      `${colors.green}✓ Receiver is online and healthy${colors.reset} (uptime: ${Math.round(health.uptime)}s)\n`,
    );
  } catch (err) {
    console.log(
      `${colors.yellow}Receiver not detected externally. Starting in-process receiver on port 5050...${colors.reset}`,
    );
    const mod = await import("../src/server.mjs");
    inProcessServer = mod.default;
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log(
      `${colors.green}✓ In-process receiver started successfully.${colors.reset}\n`,
    );
  }

  // Reset receiver state before running suite
  await fetch(`${BASE_URL}/api/reset`, { method: "POST" });

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    process.stdout.write(`• ${name}... `);
    try {
      await fn();
      console.log(`${colors.green}PASSED${colors.reset}`);
      passed++;
    } catch (err) {
      console.log(`${colors.red}FAILED${colors.reset}`);
      console.error(`  ${colors.dim}Error: ${err.message}${colors.reset}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Test 1: Connectivity check (webhook.test ping)
  // ─────────────────────────────────────────────────────────────
  await test("Scenario 1: Connectivity ping (webhook.test) -> Expect HTTP 200 & pong", async () => {
    const res = await sendWebhook({
      payload: {
        id: "evt_ping_" + Date.now(),
        event: "webhook.test",
        occurred_at: new Date().toISOString(),
        tenant_id: "11111111-2222-3333-4444-555555555555",
        data: { message: "ping" },
      },
    });

    if (res.status !== 200) {
      throw new Error(
        `Expected HTTP 200 but received HTTP ${res.status}: ${res.text}`,
      );
    }
    if (res.json?.message !== "pong") {
      throw new Error(
        `Expected response message 'pong' but received: ${JSON.stringify(res.json)}`,
      );
    }

    // Ensure inventory has 0 slots
    const slots = await fetch(`${BASE_URL}/api/slots`).then((r) => r.json());
    if (slots.providers.length > 0) {
      throw new Error("webhook.test should not modify provider slot inventory");
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Test 2: Invalid HMAC Signature
  // ─────────────────────────────────────────────────────────────
  await test("Scenario 2: Tampered HMAC signature -> Expect HTTP 401 Unauthorized", async () => {
    const res = await sendWebhook({
      payload: {
        id: "evt_bad_sig_" + Date.now(),
        event: "webhook.test",
        occurred_at: new Date().toISOString(),
        tenant_id: "11111111-2222-3333-4444-555555555555",
        data: { message: "ping" },
      },
      secret: "whsec_wrong_secret_tampered_1234567890",
    });

    if (res.status !== 401) {
      throw new Error(
        `Expected HTTP 401 for bad signature but received HTTP ${res.status}: ${res.text}`,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Test 3: Clock Skew (> 5 minutes)
  // ─────────────────────────────────────────────────────────────
  await test("Scenario 3: Timestamp clock skew (> 300s) -> Expect HTTP 401 Unauthorized", async () => {
    const expiredTimestamp = (Math.floor(Date.now() / 1000) - 400).toString(); // 400 seconds ago
    const res = await sendWebhook({
      payload: {
        id: "evt_skew_" + Date.now(),
        event: "webhook.test",
        occurred_at: new Date().toISOString(),
        tenant_id: "11111111-2222-3333-4444-555555555555",
        data: { message: "ping" },
      },
      timestamp: expiredTimestamp,
    });

    if (res.status !== 401) {
      throw new Error(
        `Expected HTTP 401 for clock skew but received HTTP ${res.status}: ${res.text}`,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Test 4: Missing Required Signature Headers
  // ─────────────────────────────────────────────────────────────
  await test("Scenario 4: Missing X-Altis-Signature header -> Expect HTTP 401 Unauthorized", async () => {
    const response = await fetch(TARGET_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Altis-Timestamp": Math.floor(Date.now() / 1000).toString(),
      },
      body: JSON.stringify({ event: "webhook.test" }),
    });

    if (response.status !== 401) {
      throw new Error(
        `Expected HTTP 401 for missing header but received HTTP ${response.status}`,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Test 5: Slot creation (availability.updated with created slots)
  // ─────────────────────────────────────────────────────────────
  const testEnvelopeId = "evt_avail_" + Date.now();
  const slot1Id = "slot-test-001";
  const slot2Id = "slot-test-002";

  await test("Scenario 5: availability.updated (created slots) -> Expect HTTP 200 & slots added to inventory", async () => {
    const res = await sendWebhook({
      payload: {
        id: testEnvelopeId,
        event: "availability.updated",
        occurred_at: new Date().toISOString(),
        tenant_id: "11111111-2222-3333-4444-555555555555",
        data: {
          therapist_id: "therapist-uuid-1234",
          provider_user_id: "provider-user-uuid-5678",
          provider_first_name: "Dr. Jane",
          provider_last_name: "Rivera",
          provider_email: "jane.rivera@clinic.example",
          slots: [
            {
              id: slot1Id,
              start_time: "2026-09-22T15:00:00.000Z",
              end_time: "2026-09-22T16:00:00.000Z",
              status: "Available",
              slot_type: "Follow-up",
              location_type: "Virtual",
              change: "created",
            },
            {
              id: slot2Id,
              start_time: "2026-09-22T16:00:00.000Z",
              end_time: "2026-09-22T17:00:00.000Z",
              status: "Available",
              slot_type: "Intake",
              location_type: "Clinic",
              change: "created",
            },
          ],
        },
      },
    });

    if (res.status !== 200) {
      throw new Error(
        `Expected HTTP 200 but received HTTP ${res.status}: ${res.text}`,
      );
    }

    const slotsRes = await fetch(`${BASE_URL}/api/slots`).then((r) => r.json());
    const provider = slotsRes.providers.find(
      (p) => p.provider_user_id === "provider-user-uuid-5678",
    );
    if (!provider) {
      throw new Error(
        "Provider Dr. Jane Rivera was not found in inventory catalog",
      );
    }
    if (provider.slots.length !== 2) {
      throw new Error(
        `Expected 2 slots in inventory, found: ${provider.slots.length}`,
      );
    }
    if (provider.bookable_slots !== 2) {
      throw new Error(
        `Expected 2 bookable slots, found: ${provider.bookable_slots}`,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Test 6: Slot status changed and slot deleted
  // ─────────────────────────────────────────────────────────────
  await test("Scenario 6: availability.updated (status_changed to Booked & deleted) -> Expect inventory updated", async () => {
    const res = await sendWebhook({
      payload: {
        id: "evt_avail_update_" + Date.now(),
        event: "availability.updated",
        occurred_at: new Date().toISOString(),
        tenant_id: "11111111-2222-3333-4444-555555555555",
        data: {
          therapist_id: "therapist-uuid-1234",
          provider_user_id: "provider-user-uuid-5678",
          provider_first_name: "Dr. Jane",
          provider_last_name: "Rivera",
          slots: [
            {
              id: slot1Id,
              status: "Booked",
              change: "status_changed",
            },
            {
              id: slot2Id,
              change: "deleted",
            },
          ],
        },
      },
    });

    if (res.status !== 200) {
      throw new Error(
        `Expected HTTP 200 but received HTTP ${res.status}: ${res.text}`,
      );
    }

    const slotsRes = await fetch(`${BASE_URL}/api/slots`).then((r) => r.json());
    const provider = slotsRes.providers.find(
      (p) => p.provider_user_id === "provider-user-uuid-5678",
    );
    if (!provider) {
      throw new Error("Provider not found in inventory");
    }

    // slot2Id must be deleted
    const slot2Exists = provider.slots.some((s) => s.id === slot2Id);
    if (slot2Exists) {
      throw new Error(
        `Slot ${slot2Id} should have been deleted from inventory`,
      );
    }

    // slot1Id must be Booked (not bookable)
    const slot1 = provider.slots.find((s) => s.id === slot1Id);
    if (!slot1) {
      throw new Error(`Slot ${slot1Id} not found in inventory`);
    }
    if (slot1.status !== "Booked" || slot1.is_bookable !== false) {
      throw new Error(
        `Slot ${slot1Id} status should be 'Booked' and not bookable, found: ${slot1.status}`,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Test 7: Idempotency deduplication
  // ─────────────────────────────────────────────────────────────
  await test("Scenario 7: Idempotency test (re-sending same envelope id) -> Expect duplicate: true & no re-processing", async () => {
    // Re-send testEnvelopeId from Scenario 5
    const res = await sendWebhook({
      payload: {
        id: testEnvelopeId,
        event: "availability.updated",
        occurred_at: new Date().toISOString(),
        tenant_id: "11111111-2222-3333-4444-555555555555",
        data: {
          therapist_id: "therapist-uuid-1234",
          provider_user_id: "provider-user-uuid-5678",
          slots: [],
        },
      },
    });

    if (res.status !== 200) {
      throw new Error(
        `Expected HTTP 200 for duplicate delivery but received HTTP ${res.status}`,
      );
    }
    if (res.json?.duplicate !== true) {
      throw new Error(
        `Expected duplicate: true in response, received: ${JSON.stringify(res.json)}`,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Test 8: Unknown event handling
  // ─────────────────────────────────────────────────────────────
  await test("Scenario 8: Unknown event type -> Expect HTTP 200 and ignored safely", async () => {
    const res = await sendWebhook({
      payload: {
        id: "evt_unknown_" + Date.now(),
        event: "patient.discharged", // Future / unknown event
        occurred_at: new Date().toISOString(),
        tenant_id: "11111111-2222-3333-4444-555555555555",
        data: { foo: "bar" },
      },
    });

    if (res.status !== 200) {
      throw new Error(
        `Expected HTTP 200 for unknown event but received HTTP ${res.status}`,
      );
    }
    if (res.json?.status !== "ignored_unknown_event") {
      throw new Error(
        `Expected ignored_unknown_event response, received: ${JSON.stringify(res.json)}`,
      );
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────
  console.log(
    `\n${colors.bold}═════════════════════════════════════════════════════════════════════${colors.reset}`,
  );
  console.log(
    `${colors.bold}TEST RESULTS: ${colors.green}${passed} Passed${colors.reset}, ${failed > 0 ? colors.red + failed + " Failed" : colors.dim + "0 Failed"}${colors.reset}`,
  );
  console.log(
    `${colors.bold}═════════════════════════════════════════════════════════════════════${colors.reset}\n`,
  );

  if (inProcessServer) {
    inProcessServer.close();
  }

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log(
      `${colors.green}${colors.bold}🎉 All 8 webhook compliance tests passed successfully!${colors.reset}\n`,
    );
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error(`${colors.red}Fatal test runner error:${colors.reset}`, err);
  process.exit(1);
});
