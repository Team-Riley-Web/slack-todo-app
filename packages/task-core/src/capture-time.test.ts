import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import { findTimeInText, resolveCaptureTime } from './capture-time.js';
import { parseCapture } from './capture.js';

const ZONE = 'America/Chicago';
/** A Thursday at 14:10 local, the moment the real task was captured. */
const NOW = DateTime.fromISO('2026-09-10T14:10:00', { zone: ZONE }).toJSDate();

const local = (d: Date | null) =>
  d === null ? null : DateTime.fromJSDate(d, { zone: ZONE }).toFormat('yyyy-MM-dd HH:mm');

describe('finding a time', () => {
  it('finds the time in the title that started this', () => {
    expect(findTimeInText('Call Andre at 3:30'))
      .toEqual({ hour: 3, minute: 30, explicit: false });
  });

  it('accepts by and @ as well as at', () => {
    expect(findTimeInText('Ship it by 5')).toEqual({ hour: 5, minute: 0, explicit: false });
    expect(findTimeInText('Standup @ 9:15')).toEqual({ hour: 9, minute: 15, explicit: false });
  });

  it('treats am and pm as explicit, in every spelling', () => {
    expect(findTimeInText('Call at 3:30pm')).toEqual({ hour: 15, minute: 30, explicit: true });
    expect(findTimeInText('Call 3:30 PM')).toEqual({ hour: 15, minute: 30, explicit: true });
    expect(findTimeInText('Call 3:30 p.m.')).toEqual({ hour: 15, minute: 30, explicit: true });
    expect(findTimeInText('Call at 9am')).toEqual({ hour: 9, minute: 0, explicit: true });
  });

  it('gets midnight and noon right', () => {
    expect(findTimeInText('Deploy at 12am')).toEqual({ hour: 0, minute: 0, explicit: true });
    expect(findTimeInText('Deploy at 12pm')).toEqual({ hour: 12, minute: 0, explicit: true });
  });

  it('treats a 24-hour time as already unambiguous', () => {
    expect(findTimeInText('Call at 15:30')).toEqual({ hour: 15, minute: 30, explicit: true });
  });

  it('needs a preposition or a meridiem, so a bare number is not a time', () => {
    // These are the false positives that would otherwise attach a due date to
    // tasks that have nothing to do with time.
    expect(findTimeInText('Fix ratio 2:1')).toBeNull();
    expect(findTimeInText('Upgrade to 3:30 branch')).toBeNull();
    expect(findTimeInText('Consolidate 401(k): move Corebridge to Fidelity')).toBeNull();
    expect(findTimeInText('Review PR 1234')).toBeNull();
    expect(findTimeInText('Read chapter 3')).toBeNull();
  });

  it('does not match inside a longer token', () => {
    expect(findTimeInText('Tag at v2:30-rc1')).toBeNull();
    expect(findTimeInText('Cut at 3:30x')).toBeNull();
  });

  it('rejects an impossible clock reading', () => {
    expect(findTimeInText('Call at 3:75')).toBeNull();
    expect(findTimeInText('Call at 25:00')).toBeNull();
    expect(findTimeInText('Call at 13pm')).toBeNull();
  });

  it('ignores a bare zero, which is a stray number far more often than midnight', () => {
    expect(findTimeInText('Set counter at 0')).toBeNull();
  });

  it('allows trailing punctuation', () => {
    expect(findTimeInText('Call Andre at 3:30.')).toEqual({ hour: 3, minute: 30, explicit: false });
    expect(findTimeInText('Call Andre at 3:30, then email')).toEqual({ hour: 3, minute: 30, explicit: false });
  });
});

describe('resolving a time to an instant', () => {
  const at = (title: string) =>
    local(resolveCaptureTime(findTimeInText(title)!, { now: NOW, timeZone: ZONE }));

  it('picks the afternoon when the morning has already gone', () => {
    // Captured at 14:10, so 03:30 is past and 15:30 is the next occurrence.
    expect(at('Call Andre at 3:30')).toBe('2026-09-10 15:30');
  });

  it('picks this morning when it is still ahead', () => {
    const morning = DateTime.fromISO('2026-09-10T06:00:00', { zone: ZONE }).toJSDate();
    const found = findTimeInText('Call at 9')!;
    expect(local(resolveCaptureTime(found, { now: morning, timeZone: ZONE })))
      .toBe('2026-09-10 09:00');
  });

  it('rolls to tomorrow when both halves of today have passed', () => {
    const evening = DateTime.fromISO('2026-09-10T22:00:00', { zone: ZONE }).toJSDate();
    const found = findTimeInText('Call at 3:30')!;
    // Predictable rather than clairvoyant: type 3:30pm to say which you meant.
    expect(local(resolveCaptureTime(found, { now: evening, timeZone: ZONE })))
      .toBe('2026-09-11 03:30');
  });

  it('respects an explicit pm even when it is past', () => {
    const evening = DateTime.fromISO('2026-09-10T22:00:00', { zone: ZONE }).toJSDate();
    const found = findTimeInText('Call at 3:30pm')!;
    expect(local(resolveCaptureTime(found, { now: evening, timeZone: ZONE })))
      .toBe('2026-09-11 15:30');
  });

  it('puts the time on the day a due token already chose', () => {
    const tomorrow = DateTime.fromISO('2026-09-11T00:00:00', { zone: ZONE }).toJSDate();
    const found = findTimeInText('Call at 3:30')!;
    expect(local(resolveCaptureTime(found, { now: NOW, timeZone: ZONE, onDay: tomorrow })))
      .toBe('2026-09-11 03:30');
  });

  it('honours a named day even when the instant is already past', () => {
    const yesterday = DateTime.fromISO('2026-09-09T00:00:00', { zone: ZONE }).toJSDate();
    const found = findTimeInText('Call at 9am')!;
    expect(local(resolveCaptureTime(found, { now: NOW, timeZone: ZONE, onDay: yesterday })))
      .toBe('2026-09-09 09:00');
  });
});

describe('capture, end to end', () => {
  const capture = (raw: string) => parseCapture(raw, { now: NOW, timeZone: ZONE });

  it('sets a due date from the time and leaves the title byte-exact', () => {
    const result = capture('Call Andre at 3:30');
    // The whole point: the time is prose the user typed, not a directive.
    expect(result.title).toBe('Call Andre at 3:30');
    expect(local(result.dueAt)).toBe('2026-09-10 15:30');
    expect(result.dueFromTitleTime).toBe(true);
  });

  it('still strips a due token, which IS a directive', () => {
    const result = capture('Call Andre due:tomorrow');
    expect(result.title).toBe('Call Andre');
    expect(local(result.dueAt)).toBe('2026-09-11 00:00');
    expect(result.dueFromTitleTime).toBeUndefined();
  });

  it('combines a due token day with a time in the title', () => {
    const result = capture('Call Andre at 3:30 due:tomorrow');
    expect(result.title).toBe('Call Andre at 3:30');
    expect(local(result.dueAt)).toBe('2026-09-11 03:30');
    expect(result.dueFromTitleTime).toBe(true);
  });

  it('combines an explicit pm with a due token', () => {
    // Three-letter days only: `due:friday` is not the grammar, `due:fri` is.
    const result = capture('Call Andre at 3:30pm due:fri');
    expect(result.title).toBe('Call Andre at 3:30pm');
    expect(local(result.dueAt)).toBe('2026-09-11 15:30');
  });

  it('leaves an unrecognised due token in the title rather than guessing', () => {
    const result = capture('Call Andre at 3:30pm due:friday');
    expect(result.title).toBe('Call Andre at 3:30pm due:friday');
    // The time is still honoured; only the malformed token is ignored.
    expect(local(result.dueAt)).toBe('2026-09-10 15:30');
  });

  it('leaves a title with no time alone', () => {
    const result = capture('Offer Neil Instagram and Facebook package for $100');
    expect(result.title).toBe('Offer Neil Instagram and Facebook package for $100');
    expect(result.dueAt).toBeNull();
  });

  it('does not invent a due date from a number that is not a time', () => {
    const result = capture('Consolidate 401(k): move Corebridge to Fidelity');
    expect(result.dueAt).toBeNull();
    expect(result.title).toBe('Consolidate 401(k): move Corebridge to Fidelity');
  });

  it('never rewrites a single byte of the title, whatever it finds', () => {
    for (const raw of [
      'Call Andre at 3:30',
      'Standup @ 9:15 with the team',
      'Ship by 5pm — no excuses',
      'Fix ratio 2:1',
    ]) {
      expect(capture(raw).title).toBe(raw);
    }
  });
});
