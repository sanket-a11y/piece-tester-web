import { describe, it, expect } from 'vitest';
import { postDiscordMessage, editDiscordMessage, NotifierError } from './notifier.js';

function fakeFetch(responses: Array<{ ok: boolean; status: number; body: string }>) {
  const calls: Array<{ url: string; init: any }> = [];
  let i = 0;
  const impl = async (url: string, init: any) => { calls.push({ url, init }); const r = responses[i++]; return { ok: r.ok, status: r.status, text: async () => r.body }; };
  return { impl, calls };
}

describe('postDiscordMessage', () => {
  it('POSTs with ?wait=true and returns the message id', async () => {
    const { impl, calls } = fakeFetch([{ ok: true, status: 200, body: JSON.stringify({ id: '999' }) }]);
    const out = await postDiscordMessage('https://discord.com/api/webhooks/1/tok', { content: 'hi' }, impl);
    expect(out.id).toBe('999');
    expect(calls[0].url).toBe('https://discord.com/api/webhooks/1/tok?wait=true');
    expect(calls[0].init.method).toBe('POST');
  });

  it('throws NotifierError on non-2xx', async () => {
    const { impl } = fakeFetch([{ ok: false, status: 400, body: 'bad' }]);
    await expect(postDiscordMessage('https://x', {}, impl)).rejects.toBeInstanceOf(NotifierError);
  });
});

describe('editDiscordMessage', () => {
  it('PATCHes /messages/{id}', async () => {
    const { impl, calls } = fakeFetch([{ ok: true, status: 200, body: '{}' }]);
    await editDiscordMessage('https://discord.com/api/webhooks/1/tok', '999', { content: 'x' }, impl);
    expect(calls[0].url).toBe('https://discord.com/api/webhooks/1/tok/messages/999');
    expect(calls[0].init.method).toBe('PATCH');
  });
});

import { errorSignature, alertEmbed, stormEmbed } from './notifier.js';

describe('errorSignature', () => {
  it('is stable across differing ids/numbers but differs by message', () => {
    const a = errorSignature('piece_error', "Cannot read property 'id' of undefined (req 12345)");
    const b = errorSignature('piece_error', "Cannot read property 'id' of undefined (req 67890)");
    const c = errorSignature('piece_error', 'Totally different error');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('piece_error:')).toBe(true);
  });
});

const baseAlert: any = { id: 7, piece_name: '@ap/stripe', target_action: 'create_customer', error_category: 'piece_error', error_message: "Cannot read 'id'", status: 'confirmed', first_seen_at: '2026-09-11T09:00:00.000Z' };

describe('alertEmbed', () => {
  it('confirmed embed is red, names the target, and includes an ack link', () => {
    const m = alertEmbed({ ...baseAlert, status: 'confirmed' }, { appBaseUrl: 'https://app.test', reproduced: 3 });
    const e = m.embeds![0];
    expect(e.color).toBe(0xED4245);
    expect(e.title).toContain('@ap/stripe');
    expect(e.description).toContain('reproduced 3×');
    expect(e.description).toContain('https://app.test/ack/7');
  });
  it('verifying embed is amber with no ack link', () => {
    const e = alertEmbed({ ...baseAlert, status: 'verifying' }, { appBaseUrl: 'https://app.test' }).embeds![0];
    expect(e.color).toBe(0xFEE75C);
    expect(e.description).not.toContain('/ack/');
  });
  it('recovered embed is green', () => {
    const e = alertEmbed({ ...baseAlert, status: 'recovered' }, { appBaseUrl: 'https://app.test', recoveredNote: 'Recovered on retest — looks flaky' }).embeds![0];
    expect(e.color).toBe(0x57F287);
    expect(e.description).toContain('flaky');
  });
  it('acknowledged embed is blurple and names who acknowledged', () => {
    const e = alertEmbed({ ...baseAlert, status: 'acknowledged', acknowledged_by: 'web session' }, { appBaseUrl: 'https://app.test' }).embeds![0];
    expect(e.color).toBe(0x5865F2);
    expect(e.description).toContain('Acknowledged by web session');
  });
});

describe('stormEmbed', () => {
  it('summarizes a mass-failure wave', () => {
    const e = stormEmbed({ failing: 23, suppressed: 15, appBaseUrl: 'https://app.test' }).embeds![0];
    expect(e.title).toContain('23');
    expect(e.description).toContain('platform');
    expect(e.description).toContain('https://app.test/');
  });
});
