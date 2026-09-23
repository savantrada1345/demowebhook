import { inventoryStore } from '../store/inventoryStore.mjs';

/**
 * Handles verified incoming webhook payloads.
 * Conforms to sections 4, 5, 6, 7 of Halo outbound-webhooks.md
 */
export function processWebhook(envelope, headers = {}) {
  if (!envelope || typeof envelope !== 'object') {
    const errorMsg = 'Invalid payload format: Expected JSON envelope object';
    inventoryStore.recordDelivery({
      status_code: 400,
      signature_valid: true,
      error: errorMsg,
      headers,
    });
    return {
      statusCode: 400,
      body: { error: errorMsg },
    };
  }

  const { id: eventId, event, occurred_at, tenant_id, data = {} } = envelope;

  // 1. Idempotency check on envelope `id` (Section 2.2 & Section 7)
  if (eventId && inventoryStore.isDuplicate(eventId)) {
    console.log(`[WEBHOOK-IDEMPOTENT] Duplicate delivery skipped for id: ${eventId}`);
    inventoryStore.recordDelivery({
      envelope_id: eventId,
      event,
      occurred_at,
      status_code: 200,
      signature_valid: true,
      is_duplicate: true,
      tenant_id,
      headers,
      payload: envelope,
    });

    return {
      statusCode: 200,
      body: {
        received: true,
        duplicate: true,
        message: `Event ${eventId} has already been processed`,
      },
    };
  }

  // 2. Route based on event type
  switch (event) {
    case 'webhook.test': {
      console.log(`[WEBHOOK-TEST] Received connectivity check ping for tenant: ${tenant_id}`);
      inventoryStore.markProcessed(eventId);
      inventoryStore.recordDelivery({
        envelope_id: eventId,
        event,
        occurred_at,
        status_code: 200,
        signature_valid: true,
        tenant_id,
        headers,
        payload: envelope,
      });

      // Section 5: Return HTTP 200. Do not create or delete slots.
      return {
        statusCode: 200,
        body: {
          received: true,
          event: 'webhook.test',
          message: 'pong',
        },
      };
    }

    case 'availability.updated': {
      const {
        therapist_id,
        provider_user_id,
        provider_first_name,
        provider_last_name,
        provider_email,
        slots = [],
      } = data;

      const providerName =
        [provider_first_name, provider_last_name].filter(Boolean).join(' ') ||
        'Unknown Provider';

      console.log(
        `[WEBHOOK-AVAILABILITY] Received ${slots.length} slot deltas for provider: ${providerName} (${provider_user_id || therapist_id})`
      );

      // Section 7: Apply slot deltas
      const appliedActions = inventoryStore.applySlotChanges(
        {
          therapist_id,
          provider_user_id,
          provider_first_name,
          provider_last_name,
          provider_email,
        },
        slots
      );

      inventoryStore.markProcessed(eventId);
      inventoryStore.recordDelivery({
        envelope_id: eventId,
        event,
        occurred_at,
        status_code: 200,
        signature_valid: true,
        tenant_id,
        therapist_id,
        provider_name: providerName,
        slots_count: slots.length,
        headers,
        payload: envelope,
      });

      return {
        statusCode: 200,
        body: {
          received: true,
          event: 'availability.updated',
          slots_processed: slots.length,
          actions_applied: appliedActions.length,
        },
      };
    }

    default: {
      console.log(`[WEBHOOK-UNKNOWN] Received unknown event: "${event}". Logging and returning 200.`);
      inventoryStore.markProcessed(eventId);
      inventoryStore.recordDelivery({
        envelope_id: eventId,
        event: event || 'unknown',
        occurred_at,
        status_code: 200,
        signature_valid: true,
        tenant_id,
        headers,
        payload: envelope,
      });

      // Section 1 & 4: Ignore unknown event values with HTTP 200 so Halo does not retry forever.
      return {
        statusCode: 200,
        body: {
          received: true,
          status: 'ignored_unknown_event',
        },
      };
    }
  }
}
