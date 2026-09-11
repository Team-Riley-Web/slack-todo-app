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

// --- leading priority token, 2026-09-11 ---

describe('a priority written into the capture text', () => {
  const cap = (raw: string) =>
    parseCapture(raw, { now: new Date('2026-09-11T12:00:00Z'), timeZone: 'America/Chicago' });

  it('lifts P0 out of the title and stores it structurally', () => {
    const r = cap('P0 Fix Stripe checkout');
    expect(r.title).toBe('Fix Stripe checkout');
    expect(r.priority).toBe('P0');
  });

  it('accepts every level, in any case', () => {
    expect(cap('p1 Finish client homepage').priority).toBe('P1');
    expect(cap('P2 Review the brief').priority).toBe('P2');
    expect(cap('p3 Tidy the shelf').priority).toBe('P3');
    expect(cap('p1 Finish client homepage').title).toBe('Finish client homepage');
  });

  it('leaves a task with no priority exactly as it was', () => {
    const r = cap('Update footer links');
    expect(r.title).toBe('Update footer links');
    expect(r.priority).toBeNull();
  });

  /**
   * The cases that make this leading-only and whitespace-delimited. Each of
   * these would have had a word silently deleted from the title by a looser
   * parser.
   */
  it('does not mistake P01, P4, or a bare P for a priority', () => {
    for (const raw of ['P01 something', 'P4 something', 'P something', 'PO something']) {
      expect(cap(raw).priority).toBeNull();
      expect(cap(raw).title).toBe(raw);
    }
  });

  it('does not touch a priority-looking token anywhere but the front', () => {
    for (const raw of [
      'Order 20 P2 cable ties',
      'Chase the P1 visa application',
      'Replace the P3 bracket on the trailer',
      'Deploy to P0',
    ]) {
      expect(cap(raw).priority).toBeNull();
      expect(cap(raw).title).toBe(raw);
    }
  });

  it('never consumes the whole input', () => {
    // `/task P0` is a task called "P0", not a priority with nothing to apply to.
    expect(cap('P0').title).toBe('P0');
    expect(cap('P0').priority).toBeNull();
    expect(cap('  P0   ').title).toBe('P0');
  });

  it('composes with a trailing due: token', () => {
    const r = cap('P1 Send the proposal due:2026-09-18');
    expect(r.title).toBe('Send the proposal');
    expect(r.priority).toBe('P1');
    expect(r.dueAt).toBeInstanceOf(Date);
  });

  it('composes with a clock time, which still never alters the title', () => {
    const r = cap('P0 Call Andre at 3:30');
    expect(r.title).toBe('Call Andre at 3:30');
    expect(r.priority).toBe('P0');
    expect(r.dueFromTitleTime).toBe(true);
  });

  it('keeps every other byte of the title', () => {
    const r = cap('P2 Offer Neil *$100* — Milltown’s reply 🚀');
    expect(r.title).toBe('Offer Neil *$100* — Milltown’s reply 🚀');
  });
});
