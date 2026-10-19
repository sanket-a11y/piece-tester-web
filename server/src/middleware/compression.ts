import compression from 'compression';
import type { Request, Response } from 'express';

/** SSE must stream event-by-event; compression would buffer it, so those responses are skipped. */
export function shouldCompress(req: Request, res: Response): boolean {
  if (String(req.headers.accept ?? '').includes('text/event-stream')) return false;
  if (String(res.getHeader('Content-Type') ?? '').includes('text/event-stream')) return false;
  return compression.filter(req, res);
}

export const compressResponses = compression({ filter: shouldCompress });
