import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './schema.js';
import { getSettings, updateSettings } from './queries.js';

describe('notify settings', () => {
  beforeEach(() => {
    getDb().run(`UPDATE settings SET notify_webhook_url='', notify_enabled=0, notify_storm_threshold=8, notify_retest_count=2, notify_reauth_digest_time='09:00' WHERE id=1`);
  });

  it('round-trips the discord webhook + toggles', () => {
    updateSettings({ notify_webhook_url: 'https://discord.com/api/webhooks/1/abc', notify_enabled: 1, notify_storm_threshold: 5, notify_retest_count: 3, notify_reauth_digest_time: '13:30' });
    const s = getSettings();
    expect(s.notify_webhook_url).toBe('https://discord.com/api/webhooks/1/abc');
    expect(s.notify_enabled).toBe(1);
    expect(s.notify_storm_threshold).toBe(5);
    expect(s.notify_retest_count).toBe(3);
    expect(s.notify_reauth_digest_time).toBe('13:30');
  });
});
