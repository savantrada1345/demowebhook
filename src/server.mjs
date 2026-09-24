import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyWebhook } from "./middleware/verifyWebhook.mjs";
import { processWebhook } from "./handlers/webhookHandler.mjs";
import { inventoryStore } from "./store/inventoryStore.mjs";
import { secretStore } from "./store/secretStore.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, "../.env");

// Load .env using native Node 20.6+ support
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    // .env file might be absent or already populated in environment
  }
}

const PORT = process.env.PORT || 5055;

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

// Request handler for both HTTP and HTTPS
async function handleRequest(req, res) {
  // Common CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Altis-Timestamp, X-Altis-Signature, User-Agent",
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`,
  );
  const pathname = parsedUrl.pathname;
  const startTime = Date.now();

  // Route 1: The Outbound Webhook Receiver Endpoint
  if (req.method === "POST" && pathname === "/webhooks/altis") {
    try {
      // Capture raw body before JSON parsing (Section 3.1)
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");

      // Step 1: Verify HMAC signature and timestamp skew
      const verification = verifyWebhook(req, rawBody);

      if (!verification.isValid) {
        inventoryStore.recordDelivery({
          event: "unknown",
          status_code: verification.statusCode,
          signature_valid: false,
          error: verification.error,
          headers: req.headers,
        });
        sendJson(res, verification.statusCode, { error: verification.error });
        return;
      }

      // Step 2: Parse JSON envelope
      let envelope;
      try {
        envelope = JSON.parse(rawBody);
      } catch (parseError) {
        const errorMsg = "Malformed JSON body";
        inventoryStore.recordDelivery({
          event: "unknown",
          status_code: 400,
          signature_valid: true,
          error: errorMsg,
          headers: req.headers,
        });
        sendJson(res, 400, { error: errorMsg });
        return;
      }

      // Step 3: Process the envelope (idempotency, availability, ping, etc.)
      const result = processWebhook(envelope, req.headers);
      sendJson(res, result.statusCode, result.body);

      const duration = Date.now() - startTime;
      console.log(
        `[HTTP] POST /webhooks/altis ${result.statusCode} ${duration}ms - event: ${envelope.event}`,
      );
    } catch (err) {
      console.error("[UNCAUGHT-ERROR]", err);
      sendJson(res, 500, {
        error: "Internal Server Error",
        message: err.message,
      });
    }
    return;
  }

  // Route 2: Inspection APIs
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/logs") {
    sendJson(res, 200, {
      total: inventoryStore.deliveries.length,
      deliveries: inventoryStore.getLogs(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/slots") {
    sendJson(res, 200, {
      providers: inventoryStore.getSlotsGrouped(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/stats") {
    sendJson(res, 200, inventoryStore.getStats());
    return;
  }

  if (req.method === "POST" && pathname === "/api/reset") {
    inventoryStore.reset();
    sendJson(res, 200, {
      success: true,
      message: "Store reset successfully",
    });
    return;
  }

  // Get current active secret
  if (req.method === "GET" && pathname === "/api/secret") {
    sendJson(res, 200, {
      secret: secretStore.getSecret(),
    });
    return;
  }

  // Dynamically update active secret without restarting server
  if (req.method === "POST" && pathname === "/api/secret") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body.secret || typeof body.secret !== "string") {
        sendJson(res, 400, {
          error: "Missing or invalid secret field in JSON",
        });
        return;
      }
      const updatedSecret = secretStore.setSecret(body.secret);
      sendJson(res, 200, {
        success: true,
        message: "Webhook secret updated successfully in memory!",
        secret: updatedSecret,
      });
    } catch (err) {
      sendJson(res, 400, { error: "Invalid JSON request body" });
    }
    return;
  }

  // Route 3: Web Dashboard (public/index.html)
  if (
    req.method === "GET" &&
    (pathname === "/" || pathname === "/index.html")
  ) {
    try {
      const htmlPath = path.join(__dirname, "../public/index.html");
      const content = await fsPromises.readFile(htmlPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error loading dashboard");
    }
    return;
  }

  // 404 Not Found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
}

// Check for SSL certificates in certs/ directory
const certsDir = path.join(__dirname, "../certs");
const keyPath = path.join(certsDir, "key.pem");
const certPath = path.join(certsDir, "cert.pem");

const hasSslCerts = fs.existsSync(keyPath) && fs.existsSync(certPath);
const isHttps = process.env.HTTPS === "true" || hasSslCerts;

let server;
let protocol = "http";

if (isHttps && hasSslCerts) {
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  server = https.createServer(options, handleRequest);
  protocol = "https";
} else {
  server = http.createServer(handleRequest);
  protocol = "http";
}

server.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log(
    `🚀 Halo Outbound Webhook Receiver is running (${protocol.toUpperCase()})!`,
  );
  console.log(
    `📍 Webhook Endpoint: ${protocol}://localhost:${PORT}/webhooks/altis`,
  );
  console.log(`📊 Web Dashboard:    ${protocol}://localhost:${PORT}/`);
  if (protocol === "http") {
    console.log(
      `💡 Tip: HaloAPI requires HTTPS for webhooks. To test with HaloAPI:`,
    );
    console.log(
      `   - Option A (Public URL): Run 'npm run tunnel' (uses ngrok)`,
    );
    console.log(`   - Option B (Local HTTPS): Run 'npm run generate-certs'`);
  }
  console.log("=".repeat(60));
});

export default server;
