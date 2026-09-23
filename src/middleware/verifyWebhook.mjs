import crypto from 'node:crypto';
import { inventoryStore } from '../store/inventoryStore.mjs';
import { secretStore } from '../store/secretStore.mjs';

/**
 * Strictly implements Section 3 of Halo outbound-webhooks.md:
 * 1. Read X-Altis-Timestamp and X-Altis-Signature.
 * 2. Reject the request (401) if either header is missing.
 * 3. Reject if |now - timestamp| > 300s (5 minutes).
 * 4. Use the raw request body as received (UTF-8).
 * 5. Compute HMAC-SHA256(secret, "{timestamp}.{rawBody}").
 * 6. Compare using timing-safe equality check.
 */
export function verifyWebhook(req, rawBody) {
  const secret = secretStore.getSecret();
  const maxSkewSec = parseInt(process.env.MAX_SKEW_SEC || '300', 10);

  if (!secret) {
    const error =
      'Server misconfiguration: ALTIS_WEBHOOK_SECRET is not configured. Set it in the dashboard UI or .env';
    console.error(`[VERIFY-ERROR] ${error}`);
    return { isValid: false, statusCode: 500, error };
  }

  const timestamp = req.headers['x-altis-timestamp'];
  const signature = req.headers['x-altis-signature'];

  // 1. Missing headers or raw body check
  if (!timestamp || !signature) {
    const error = 'Missing required signature headers (X-Altis-Timestamp or X-Altis-Signature)';
    console.warn(`[VERIFY-FAIL] ${error}`);
    return { isValid: false, statusCode: 401, error, timestamp, signature };
  }

  if (rawBody === undefined || rawBody === null) {
    const error = 'Raw request body is missing for HMAC verification';
    console.warn(`[VERIFY-FAIL] ${error}`);
    return { isValid: false, statusCode: 401, error, timestamp, signature };
  }

  // 2. Clock skew check (<= 5 minutes)
  const now = Math.floor(Date.now() / 1000);
  const parsedTimestamp = Number(timestamp);

  if (Number.isNaN(parsedTimestamp) || Math.abs(now - parsedTimestamp) > maxSkewSec) {
    const skew = Math.abs(now - parsedTimestamp);
    const error = `Timestamp skew too large (${skew}s > ${maxSkewSec}s threshold). Request expired or clock out of sync.`;
    console.warn(`[VERIFY-FAIL] ${error}`);
    return { isValid: false, statusCode: 401, error, timestamp, signature };
  }

  // 3. Compute HMAC-SHA256
  const hmacPayload = `${timestamp}.${rawBody}`;
  const computedHash = crypto
    .createHmac('sha256', secret)
    .update(hmacPayload)
    .digest('hex');
  const expectedSignature = `sha256=${computedHash}`;

  // 4. Constant-time equality check
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  const isValid =
    sigBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(sigBuffer, expectedBuffer);

  if (!isValid) {
    const secretPreview = secret.slice(0, 10) + '...' + secret.slice(-4);
    const error = `Invalid webhook signature: HMAC-SHA256 digest did not match expected value. Used secret: ${secretPreview}`;
    console.warn(`[VERIFY-FAIL] ${error}`);
    console.warn(`[VERIFY-DEBUG] Received signature: ${signature}`);
    console.warn(`[VERIFY-DEBUG] Computed signature: ${expectedSignature}`);
    return {
      isValid: false,
      statusCode: 401,
      error,
      timestamp,
      signature,
      expectedSignature,
      secretPreview,
    };
  }

  return { isValid: true, statusCode: 200, timestamp, signature };
}
