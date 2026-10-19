import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { compressResponses } from './compression.js';

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function start(): Promise<string> {
  const app = express();
  app.use(compressResponses);
  app.get('/json', (_req, res) => { res.json({ rows: 'x'.repeat(5000) }); });
  app.get('/sse', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write(`event: tick\ndata: ${'y'.repeat(2000)}\n\n`);
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  return new Promise(resolve => server.on('listening', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function get(url: string, accept?: string): Promise<{ encoding?: string; firstChunk: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: { 'Accept-Encoding': 'gzip', ...(accept ? { Accept: accept } : {}) } }, res => {
      res.once('data', chunk => { resolve({ encoding: res.headers['content-encoding'], firstChunk: chunk.toString() }); req.destroy(); });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('compressResponses', () => {
  it('gzips ordinary JSON responses', async () => {
    const base = await start();
    expect((await get(`${base}/json`)).encoding).toBe('gzip');
  });

  it('streams SSE uncompressed so each event arrives immediately', async () => {
    const base = await start();
    const res = await get(`${base}/sse`);
    expect(res.encoding).toBeUndefined();
    expect(res.firstChunk).toContain('event: tick');
    const withAccept = await get(`${base}/sse`, 'text/event-stream');
    expect(withAccept.encoding).toBeUndefined();
  });
});
