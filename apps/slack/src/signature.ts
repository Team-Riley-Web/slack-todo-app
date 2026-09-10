import { createHmac, timingSafeEqual } from 'node:crypto';

const FIVE_MINUTES = 60 * 5;

export interface VerifyArgs {
  signingSecret: string;
  requestSignature: string;
  requestTimestamp: number;
  body: string;
  nowSeconds?: number;
}

/** Used only in HTTP mode. Socket Mode authenticates via the app-level token. */
export function verifySlackSignature(args: VerifyArgs): boolean {
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(args.requestTimestamp)) return false;
  if (Math.abs(now - args.requestTimestamp) > FIVE_MINUTES) return false;

  const expected = `v0=${createHmac('sha256', args.signingSecret)
    .update(`v0:${args.requestTimestamp}:${args.body}`)
    .digest('hex')}`;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(args.requestSignature ?? '', 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
