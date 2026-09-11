import { Router } from 'express';
import { getAlert, acknowledgeAlert, getSettings } from '../db/queries.js';
import { alertEmbed, editDiscordMessage } from '../services/notifier.js';

const router = Router();

router.post('/:id/acknowledge', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid alert id' });
  const alert = getAlert(id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (alert.recovered_at) return res.json({ success: true, alreadyResolved: true });

  const by = 'web session';
  const acked = acknowledgeAlert(id, by);
  if (!acked) return res.status(404).json({ error: 'Alert not found' });

  const s = getSettings();
  if (s.notify_webhook_url && acked.discord_message_id) {
    const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    try { await editDiscordMessage(s.notify_webhook_url, acked.discord_message_id, alertEmbed({ ...acked, status: 'acknowledged' }, { appBaseUrl: base })); }
    catch (err) { console.error('[alerts] failed to edit ack message:', err); }
  }
  res.json({ success: true, acknowledged_by: by });
});

export default router;
