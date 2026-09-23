import { Router } from 'express';
import { inventoryStore } from '../store/inventoryStore.mjs';

const router = Router();

// Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Get received webhook logs
router.get('/logs', (req, res) => {
  res.json({
    total: inventoryStore.deliveries.length,
    deliveries: inventoryStore.getLogs(),
  });
});

// Get current slot inventory grouped by provider
router.get('/slots', (req, res) => {
  res.json({
    providers: inventoryStore.getSlotsGrouped(),
  });
});

// Get aggregated statistics
router.get('/stats', (req, res) => {
  res.json(inventoryStore.getStats());
});

// Reset all store data (useful before running fresh tests)
router.post('/reset', (req, res) => {
  inventoryStore.reset();
  res.json({
    success: true,
    message: 'Store reset successfully',
  });
});

export default router;
