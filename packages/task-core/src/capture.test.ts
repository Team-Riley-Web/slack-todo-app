import { describe, it, expect } from 'vitest';
import { parseCapture } from './capture.js';

const now = new Date('2026-09-09T15:00:00Z'); // Wednesday
const opts = { now, timeZone: 'America/Chicago' };

describe('exact title preservation', () => {
  // Required test 1
  it('stores the literal title verbatim', () => {
    const raw = 'Offer Neil Instagram and Facebook package for $100';
    expect(parseCapture(raw, opts).title).toBe(raw);
  });

  it('never rewrites, summarizes, or normalizes', () => {
    for (const raw of [
      'Call Neil',
      'Prepare Joy Within launch checklist',
      'Renew vehicle registration',
      'Consolidate 401(k): move Corebridge to Fidelity',
      'Waiting on Milltown’s reply to the email proposal',
      'Secure Logic — three-month honeymoon check-in with Marty',
      'Give Rachael access to Marty’s photos',
      'fix *urgent* bug_now~ish~ `code`',
      'multiple   internal    spaces',
      'due tomorrow is part of this title',
      'read docs at https://example.com/a_b_c',
    ]) {
      expect(parseCapture(raw, opts).title).toBe(raw);
      expect(parseCapture(raw, opts).dueAt).toBeNull();
    }
  });

  it('trims only outer whitespace, the single permitted normalization', () => {
    expect(parseCapture('  Call Neil  ', opts).title).toBe('Call Neil');
  });
});

describe('strict due: suffix grammar', () => {
  it('parses an ISO date and strips only the token', () => {
    const r = parseCapture('Call Neil due:2026-09-15', opts);
    expect(r.title).toBe('Call Neil');
    expect(r.dueAt?.toISOString()).toBe('2026-09-15T05:00:00.000Z'); // CDT midnight
  });

  it('parses today and tomorrow in the configured zone', () => {
    expect(parseCapture('X due:today', opts).dueAt?.toISOString()).toBe('2026-09-09T05:00:00.000Z');
    expect(parseCapture('X due:tomorrow', opts).dueAt?.toISOString()).toBe('2026-09-10T05:00:00.000Z');
  });

  it('parses a weekday as the next strictly-future occurrence', () => {
    expect(parseCapture('X due:fri', opts).dueAt?.toISOString()).toBe('2026-09-11T05:00:00.000Z');
    expect(parseCapture('X due:wed', opts).dueAt?.toISOString()).toBe('2026-09-16T05:00:00.000Z');
  });

  it('is case-insensitive on the token only', () => {
    expect(parseCapture('X DUE:TOMORROW', opts).title).toBe('X');
  });

  it('ignores a due token that is not the final token', () => {
    const raw = 'due:2026-09-15 call Neil';
    expect(parseCapture(raw, opts).title).toBe(raw);
    expect(parseCapture(raw, opts).dueAt).toBeNull();
  });

  it('ignores malformed and out-of-range tokens, keeping them in the title', () => {
    for (const raw of ['X due:9/15', 'X due:next-week', 'X due:', 'X due:2026-13-45', 'Xdue:today']) {
      expect(parseCapture(raw, opts).title).toBe(raw);
      expect(parseCapture(raw, opts).dueAt).toBeNull();
    }
  });

  it('never leaves an empty title', () => {
    expect(parseCapture('due:today', opts).title).toBe('due:today');
    expect(parseCapture('due:today', opts).dueAt).toBeNull();
  });
});
