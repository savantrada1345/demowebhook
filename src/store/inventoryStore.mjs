/**
 * In-memory store for:
 * 1. Processed envelope IDs (for idempotency deduplication - Section 2.2 & 7)
 * 2. Provider Slot Inventory (Section 6 & 7)
 * 3. Incoming Webhook Deliveries Log (for UI and inspection APIs)
 */

class InventoryStore {
  constructor() {
    this.reset();
  }

  reset() {
    this.processedEnvelopeIds = new Set();
    // Map of providerKey -> { provider_user_id, therapist_id, name, email, slots: Map<slotId, Slot> }
    this.providers = new Map();
    // List of received webhook deliveries
    this.deliveries = [];
    // Aggregated statistics
    this.stats = {
      totalReceived: 0,
      pings: 0,
      availabilityUpdates: 0,
      unknownEvents: 0,
      duplicates: 0,
      verificationFailures: 0,
      lastReceivedAt: null,
    };
  }

  isDuplicate(envelopeId) {
    if (!envelopeId) return false;
    return this.processedEnvelopeIds.has(envelopeId);
  }

  markProcessed(envelopeId) {
    if (envelopeId) {
      this.processedEnvelopeIds.add(envelopeId);
    }
  }

  recordDelivery(entry) {
    const record = {
      id: entry.id || `rec_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      envelope_id: entry.envelope_id || null,
      event: entry.event || 'unknown',
      occurred_at: entry.occurred_at || null,
      received_at: new Date().toISOString(),
      status_code: entry.status_code || 200,
      signature_valid: entry.signature_valid ?? true,
      error: entry.error || null,
      tenant_id: entry.tenant_id || null,
      therapist_id: entry.therapist_id || null,
      provider_name: entry.provider_name || null,
      slots_count: entry.slots_count ?? 0,
      headers: entry.headers || {},
      payload: entry.payload || null,
    };

    this.deliveries.unshift(record);
    // Keep last 200 records in memory
    if (this.deliveries.length > 200) {
      this.deliveries.pop();
    }

    this.stats.totalReceived++;
    this.stats.lastReceivedAt = record.received_at;

    if (!record.signature_valid) {
      this.stats.verificationFailures++;
    } else if (entry.is_duplicate) {
      this.stats.duplicates++;
    } else if (record.event === 'webhook.test') {
      this.stats.pings++;
    } else if (record.event === 'availability.updated') {
      this.stats.availabilityUpdates++;
    } else {
      this.stats.unknownEvents++;
    }

    return record;
  }

  /**
   * Apply slot changes to inventory based on section 7 of outbound-webhooks.md:
   * Match provider with provider_user_id first, then therapist_id.
   *
   * Change matrix:
   * - created + Available -> Insert open bookable slot
   * - created + other -> Insert with that status; do not offer unless Available
   * - deleted + any -> Remove slot by id
   * - status_changed + Booked -> Mark filled / stop offering
   * - status_changed + Available -> Re-open
   * - status_changed + Block -> Hide / not bookable
   * - status_changed + Cancelled -> Hide / not open inventory
   *
   * Process slots in order. If same id appears twice, last object wins.
   */
  applySlotChanges(providerMeta, slots = []) {
    const providerKey =
      providerMeta.provider_user_id ||
      providerMeta.therapist_id ||
      'unknown_provider';

    if (!this.providers.has(providerKey)) {
      this.providers.set(providerKey, {
        provider_key: providerKey,
        provider_user_id: providerMeta.provider_user_id || null,
        therapist_id: providerMeta.therapist_id || null,
        name:
          [providerMeta.provider_first_name, providerMeta.provider_last_name]
            .filter(Boolean)
            .join(' ') || 'Unnamed Provider',
        email: providerMeta.provider_email || null,
        slots: new Map(),
      });
    }

    const provider = this.providers.get(providerKey);
    // Update provider profile info if available
    if (providerMeta.provider_first_name || providerMeta.provider_last_name) {
      provider.name = [providerMeta.provider_first_name, providerMeta.provider_last_name]
        .filter(Boolean)
        .join(' ');
    }
    if (providerMeta.provider_email) {
      provider.email = providerMeta.provider_email;
    }

    const appliedActions = [];

    for (const slot of slots) {
      if (!slot || !slot.id) continue;

      const slotId = slot.id;
      const change = slot.change; // 'created' | 'deleted' | 'status_changed'
      const status = slot.status; // 'Available' | 'Booked' | 'Cancelled' | 'Block'

      if (change === 'deleted') {
        const existed = provider.slots.delete(slotId);
        appliedActions.push({
          slot_id: slotId,
          action: 'deleted',
          existed,
        });
      } else if (change === 'created') {
        const slotData = {
          id: slotId,
          start_time: slot.start_time || null,
          end_time: slot.end_time || null,
          status: status || 'Available',
          slot_type: slot.slot_type || null,
          location_type: slot.location_type || null,
          is_bookable: status === 'Available',
          last_updated: new Date().toISOString(),
        };
        provider.slots.set(slotId, slotData);
        appliedActions.push({
          slot_id: slotId,
          action: 'created',
          status: slotData.status,
          is_bookable: slotData.is_bookable,
        });
      } else if (change === 'status_changed') {
        const existingSlot = provider.slots.get(slotId) || {
          id: slotId,
          start_time: slot.start_time || null,
          end_time: slot.end_time || null,
          slot_type: slot.slot_type || null,
          location_type: slot.location_type || null,
        };

        existingSlot.status = status;
        existingSlot.is_bookable = status === 'Available';
        if (slot.start_time) existingSlot.start_time = slot.start_time;
        if (slot.end_time) existingSlot.end_time = slot.end_time;
        if (slot.slot_type) existingSlot.slot_type = slot.slot_type;
        if (slot.location_type) existingSlot.location_type = slot.location_type;
        existingSlot.last_updated = new Date().toISOString();

        provider.slots.set(slotId, existingSlot);
        appliedActions.push({
          slot_id: slotId,
          action: 'status_changed',
          status: existingSlot.status,
          is_bookable: existingSlot.is_bookable,
        });
      }
    }

    return appliedActions;
  }

  getSlotsGrouped() {
    const result = [];
    for (const provider of this.providers.values()) {
      const slotsArray = Array.from(provider.slots.values());
      result.push({
        provider_key: provider.provider_key,
        provider_user_id: provider.provider_user_id,
        therapist_id: provider.therapist_id,
        name: provider.name,
        email: provider.email,
        total_slots: slotsArray.length,
        bookable_slots: slotsArray.filter((s) => s.is_bookable).length,
        slots: slotsArray,
      });
    }
    return result;
  }

  getLogs() {
    return this.deliveries;
  }

  getStats() {
    let totalSlots = 0;
    let totalBookableSlots = 0;
    for (const provider of this.providers.values()) {
      totalSlots += provider.slots.size;
      for (const slot of provider.slots.values()) {
        if (slot.is_bookable) totalBookableSlots++;
      }
    }

    return {
      ...this.stats,
      totalProviders: this.providers.size,
      totalSlots,
      totalBookableSlots,
    };
  }
}

export const inventoryStore = new InventoryStore();
