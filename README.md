# Halo Outbound Webhooks External Receiver & Testing Harness

This project is a standalone Node.js external application designed to test and verify Halo outbound webhooks in a realistic external receiver environment.

It strictly adheres to all requirements documented in [`HaloAPI/documentation/outbound-webhooks.md`](../HaloAPI/documentation/outbound-webhooks.md).

---

## Features

- **HMAC-SHA256 Signature Verification** (Section 3 of guide):
  - Captures `rawBody` before parsing JSON.
  - Verifies `X-Altis-Signature` (`sha256=...`) and `X-Altis-Timestamp`.
  - Enforces clock skew limit ($\le 300$ seconds / 5 minutes).
  - Uses constant-time `crypto.timingSafeEqual` comparison.
  - Returns `401 Unauthorized` for missing headers, expired timestamps, or invalid signatures.
- **Envelope & Idempotency** (Section 2.2 & 7):
  - Deduplicates on envelope `id` UUID. Returns HTTP 200 without reprocessing duplicates.
- **Event Handling** (Sections 4, 5, 6, 7):
  - `webhook.test`: Connectivity check; returns HTTP 200 with `{ received: true, message: 'pong' }` without changing inventory.
  - `availability.updated`: Updates catalog according to Section 7:
    - `created` + `Available` $\to$ inserts open bookable slot.
    - `created` + other $\to$ inserts slot with that status.
    - `deleted` $\to$ removes slot by `id`.
    - `status_changed` $\to$ marks `Booked`, `Block`, `Cancelled`, or `Available`.
    - Matches provider by `provider_user_id` or `therapist_id`.
  - Unknown events: Safely logs and returns HTTP 200 to avoid infinite retry storms.
- **Real-Time Web Dashboard** (`http://localhost:5050`):
  - Live stream of received webhooks, signature status, and expandable payload inspector.
  - Live provider slot inventory catalog.
- **Automated Compliance Test Suite** (`npm test`):
  - Executes 8 distinct test scenarios verifying every edge case.

---

## Quick Start

### 1. Install Dependencies

```bash
cd webhook-tester
npm install
```

### 2. Start the Receiver Server

```bash
npm start
```

The server runs on port `5050` by default:
- **Webhook Endpoint**: `http://localhost:5050/webhooks/altis`
- **Web Dashboard**: `http://localhost:5050/`
- **Inspection API**: `http://localhost:5050/api/logs`

### 3. Run Automated Compliance Simulation Tests

In a separate terminal:

```bash
cd webhook-tester
npm test
```

This simulates all 8 scenarios:
1. `webhook.test` ping check (HTTP 200, no inventory change).
2. Tampered HMAC signature (HTTP 401).
3. Clock skew $> 300$ seconds (HTTP 401).
4. Missing required signature headers (HTTP 401).
5. `availability.updated` with created slots (HTTP 200, slots added to catalog).
6. `availability.updated` with status change and deletion (HTTP 200, catalog updated).
7. Idempotency re-send of duplicate envelope `id` (HTTP 200, duplicate detected).
8. Unknown event handling (HTTP 200, safely ignored).

---

## Testing with Real HaloAPI Instance

Follow these steps to connect this receiver to a live running `HaloAPI` instance:

### Step 1: Start the Webhook Receiver

```bash
cd webhook-tester
npm start
```

### Step 2: Register the Webhook in HaloAPI

Authenticate as an admin in HaloAPI and send a `POST` request to `/webhooks`:

```bash
curl -X POST http://localhost:4000/webhooks \
  -H "Authorization: Bearer <YOUR_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Local Test Receiver",
    "url": "http://localhost:5050/webhooks/altis",
    "events": ["availability.updated", "webhook.test"],
    "is_active": true
  }'
```

The response will contain the signing secret:
```json
{
  "id": "sub_12345...",
  "name": "Local Test Receiver",
  "url": "http://localhost:5050/webhooks/altis",
  "events": ["availability.updated", "webhook.test"],
  "secret": "whsec_abcdef0123456789..."
}
```

### Step 3: Configure the Secret in Webhook Receiver

Copy the `secret` value from the response above into `webhook-tester/.env`:

```env
PORT=5050
ALTIS_WEBHOOK_SECRET=whsec_abcdef0123456789...
MAX_SKEW_SEC=300
```

Restart `webhook-tester` if it was already running.

### Step 4: Trigger a Connectivity Test Ping

Call the test endpoint on HaloAPI:

```bash
curl -X POST http://localhost:4000/webhooks/<SUBSCRIPTION_ID>/test \
  -H "Authorization: Bearer <YOUR_ADMIN_TOKEN>"
```

Check the Webhook Receiver Dashboard (`http://localhost:5050`). You should see:
- A new entry in the log with event `webhook.test`.
- `HMAC OK` badge.
- Status 200 with response `{ received: true, message: 'pong' }`.

### Step 5: Test Real Availability Changes

Ensure the background worker is running in HaloAPI:
```bash
npm run worker:webhooks:dev
```

In HaloAPI, create, update, or cancel therapist availability slots (via admin or therapist scheduling UI/endpoints). Within ~10 seconds (the batching window), Halo will dispatch `availability.updated` to `http://localhost:5050/webhooks/altis`.

You will see:
1. The new webhook delivery appear in the Web Dashboard log.
2. The provider and their updated slots rendered in the **Active Inventory Catalog** table in real-time.

---

## Inspection APIs

| Endpoint | Method | Description |
| --- | --- | --- |
| `/webhooks/altis` | `POST` | The actual webhook endpoint receiving signed payloads from Halo |
| `/api/logs` | `GET` | Returns list of recent webhook deliveries with headers and payloads |
| `/api/slots` | `GET` | Returns current provider slot catalog |
| `/api/stats` | `GET` | Returns summary counters (total, pings, updates, failures, duplicates) |
| `/api/reset` | `POST` | Clears all logs, slots, and idempotency cache |
| `/api/health` | `GET` | Health check endpoint |
