import { describe, it, expect } from 'vitest';
import { parseApError } from './ap-error.js';

describe('parseApError', () => {
  it('digs through the AP wrapper + nested errorMessage JSON', () => {
    const inner = JSON.stringify({ __apErrorVersion: 1, message: 'Invalid Request: reaction must be a valid emoji', code: 'BAD_REQUEST', status: 400 });
    const raw = JSON.stringify({ status: 'FAILED', errorMessage: inner, output: null });
    const p = parseApError(raw);
    expect(p.message).toBe('Invalid Request: reaction must be a valid emoji');
    expect(p.code).toBe('BAD_REQUEST');
    expect(p.status).toBe(400);
    expect(p.raw).toContain('"__apErrorVersion": 1');
    expect(p.raw).toContain('"code": "BAD_REQUEST"');
  });

  it('handles a 404 not_found nested error', () => {
    const inner = JSON.stringify({ __apErrorVersion: 1, message: '404 page not found', code: 'NOT_FOUND', status: 404 });
    const raw = JSON.stringify({ status: 'FAILED', errorMessage: inner, output: null });
    const p = parseApError(raw);
    expect(p.message).toBe('404 page not found');
    expect(p.status).toBe(404);
  });

  it('extracts a trigger params.standardError message with no code/status', () => {
    const raw = JSON.stringify({ code: 'TRIGGER_UPDATE_STATUS', params: { standardError: 'Upstream API returned 500' } });
    const p = parseApError(raw);
    expect(p.message).toBe('Upstream API returned 500');
    expect(p.code).toBeUndefined();
    expect(p.status).toBeUndefined();
  });

  it('handles a plain-string errorMessage (no nested JSON)', () => {
    const raw = JSON.stringify({ status: 'FAILED', errorMessage: 'Cannot read properties of undefined', output: null });
    const p = parseApError(raw);
    expect(p.message).toBe('Cannot read properties of undefined');
    expect(p.code).toBeUndefined();
    expect(p.status).toBeUndefined();
  });

  it('falls back to the first line for non-JSON input', () => {
    const p = parseApError('Timed out after 90s\nstack trace line');
    expect(p.message).toBe('Timed out after 90s');
    expect(p.raw).toBe('Timed out after 90s\nstack trace line');
  });
});
