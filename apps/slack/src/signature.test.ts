import { it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from './signature.js';

const secret = 'test_signing_secret';
const body = 'token=abc&command=%2Ftask&text=Call+Neil';
const ts = 1_700_000_000;

const sign = (t: number, b: string, s = secret) =>
  `v0=${createHmac('sha256', s).update(`v0:${t}:${b}`).digest('hex')}`;

it('accepts a correctly signed request', () => {
  expect(verifySlackSignature({
    signingSecret: secret, requestSignature: sign(ts, body),
    requestTimestamp: ts, body, nowSeconds: ts + 5,
  })).toBe(true);
});

it('rejects a tampered body', () => {
  expect(verifySlackSignature({
    signingSecret: secret, requestSignature: sign(ts, body),
    requestTimestamp: ts, body: `${body}&injected=1`, nowSeconds: ts + 5,
  })).toBe(false);
});

it('rejects a signature made with the wrong secret', () => {
  expect(verifySlackSignature({
    signingSecret: secret, requestSignature: sign(ts, body, 'wrong'),
    requestTimestamp: ts, body, nowSeconds: ts + 5,
  })).toBe(false);
});

it('rejects a replay older than five minutes', () => {
  expect(verifySlackSignature({
    signingSecret: secret, requestSignature: sign(ts, body),
    requestTimestamp: ts, body, nowSeconds: ts + 301,
  })).toBe(false);
});

it('rejects a timestamp from the future beyond tolerance', () => {
  expect(verifySlackSignature({
    signingSecret: secret, requestSignature: sign(ts, body),
    requestTimestamp: ts, body, nowSeconds: ts - 301,
  })).toBe(false);
});

it('rejects a malformed or empty signature without throwing', () => {
  for (const requestSignature of ['', 'v0=', 'garbage', 'v1=abc']) {
    expect(verifySlackSignature({
      signingSecret: secret, requestSignature,
      requestTimestamp: ts, body, nowSeconds: ts + 5,
    })).toBe(false);
  }
});

it('rejects a non-numeric timestamp', () => {
  expect(verifySlackSignature({
    signingSecret: secret, requestSignature: sign(ts, body),
    requestTimestamp: Number.NaN, body, nowSeconds: ts,
  })).toBe(false);
});
