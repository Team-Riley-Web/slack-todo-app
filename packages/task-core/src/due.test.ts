import { describe, it, expect } from 'vitest';
import {
  parseDueInput, formatDueInput, calendarDaysFrom, tomorrowAt, DEFAULT_TIME_ZONE,
  resolveDueChoice, describeDueChoice,
} from './due.js';

const CHI = 'America/Chicago';

describe('parseDueInput', () => {
  it('reads a bare date as the start of that day in Chicago, not UTC', () => {
    // The bug: new Date('2026-10-14') is midnight UTC -- 7pm Oct 13 in Chicago.
    expect(parseDueInput('2026-10-14', CHI).toISOString()).toBe('2026-10-14T05:00:00.000Z');
    // CST in winter, an hour later in UTC terms.
    expect(parseDueInput('2026-12-14', CHI).toISOString()).toBe('2026-12-14T06:00:00.000Z');
  });

  it('reads a wall-clock time with no offset in Chicago', () => {
    // What a datetime-local input submits, and what a model sends without a zone.
    expect(parseDueInput('2026-10-14T09:00', CHI).toISOString()).toBe('2026-10-14T14:00:00.000Z');
    expect(parseDueInput('2026-10-14T09:00:30', CHI).toISOString()).toBe('2026-10-14T14:00:30.000Z');
  });

  it('never second-guesses an explicit Z or offset', () => {
    expect(parseDueInput('2026-10-14T09:00:00Z', CHI).toISOString()).toBe('2026-10-14T09:00:00.000Z');
    expect(parseDueInput('2026-10-14T09:00:00-07:00', CHI).toISOString()).toBe('2026-10-14T16:00:00.000Z');
  });

  it('returns an Invalid Date for nonsense, so createTask still refuses it', () => {
    expect(Number.isNaN(parseDueInput('next tuesday-ish', CHI).getTime())).toBe(true);
    expect(Number.isNaN(parseDueInput('2026-13-45', CHI).getTime())).toBe(true);
  });

  it('defaults to Chicago', () => {
    expect(DEFAULT_TIME_ZONE).toBe(CHI);
    expect(parseDueInput('2026-10-14').toISOString()).toBe('2026-10-14T05:00:00.000Z');
  });
});

describe('formatDueInput', () => {
  it('shows a due date in Chicago wall-clock time', () => {
    // A 9am Slack capture used to open in the web form as 14:00.
    expect(formatDueInput(new Date('2026-10-14T14:00:00Z'), CHI)).toBe('2026-10-14T09:00');
  });

  it('round-trips through parseDueInput, so an unchanged save moves nothing', () => {
    for (const iso of ['2026-10-14T14:00:00Z', '2026-12-01T06:00:00Z', '2026-03-08T07:30:00Z']) {
      const due = new Date(iso);
      expect(parseDueInput(formatDueInput(due, CHI), CHI).getTime()).toBe(due.getTime());
    }
  });
});

describe('calendarDaysFrom', () => {
  const now = new Date('2026-10-13T20:31:00Z'); // 3:31pm CDT, Oct 13

  it('counts 8pm tonight in Chicago as today, which UTC called tomorrow', () => {
    expect(calendarDaysFrom(new Date('2026-10-14T01:00:00Z'), now, CHI)).toBe(0);
  });

  it('counts 1am Chicago as tomorrow, and yesterday as -1', () => {
    expect(calendarDaysFrom(new Date('2026-10-14T06:00:00Z'), now, CHI)).toBe(1);
    expect(calendarDaysFrom(new Date('2026-10-12T15:00:00Z'), now, CHI)).toBe(-1);
  });

  it('stays whole across a DST change', () => {
    // Nov 1 2026 is 25 hours long in Chicago.
    const before = new Date('2026-10-31T17:00:00Z');
    expect(calendarDaysFrom(new Date('2026-11-02T18:00:00Z'), before, CHI)).toBe(2);
  });
});

describe('tomorrowAt', () => {
  const now = new Date('2026-10-13T20:31:00Z'); // 3:31pm CDT, Oct 13

  it('keeps the time of day it was due', () => {
    // 2pm CDT today -> 2pm CDT tomorrow.
    expect(tomorrowAt(new Date('2026-10-13T19:00:00Z'), now, CHI).toISOString())
      .toBe('2026-10-14T19:00:00.000Z');
  });

  it('moves overdue work to tomorrow, not one day after it was due', () => {
    // Due 9am CDT three days ago -> 9am CDT tomorrow.
    expect(tomorrowAt(new Date('2026-10-10T14:00:00Z'), now, CHI).toISOString())
      .toBe('2026-10-14T14:00:00.000Z');
  });

  it('keeps a date-only due date date-only', () => {
    expect(tomorrowAt(parseDueInput('2026-10-13', CHI), now, CHI).toISOString())
      .toBe(parseDueInput('2026-10-14', CHI).toISOString());
  });

  it('gives a task with no due date the start of tomorrow', () => {
    expect(tomorrowAt(null, now, CHI).toISOString()).toBe('2026-10-14T05:00:00.000Z');
  });

  it('is tomorrow in Chicago even late in the evening, when UTC is already on it', () => {
    const late = new Date('2026-10-14T03:30:00Z'); // 10:30pm CDT, still Oct 13
    expect(tomorrowAt(new Date('2026-10-14T02:00:00Z'), late, CHI).toISOString())
      .toBe('2026-10-15T02:00:00.000Z'); // 9pm CDT Oct 14
  });

  it('lands on the same wall-clock time across a DST change', () => {
    const sat = new Date('2026-10-31T17:00:00Z'); // noon CDT, Sat Oct 31
    // 9am CDT Sat -> 9am CST Sun, which is 15:00Z rather than 14:00Z.
    expect(tomorrowAt(new Date('2026-10-31T14:00:00Z'), sat, CHI).toISOString())
      .toBe('2026-11-01T15:00:00.000Z');
  });
});

describe('resolveDueChoice', () => {
  const now = new Date('2026-10-14T14:07:00Z'); // 9:07am CDT, Oct 14

  it('makes "Today" the day, not this minute', () => {
    // The old form defaulted to the current time, so "today" was already
    // overdue the moment it saved.
    expect(resolveDueChoice({ when: 'today' }, now, CHI)!.toISOString())
      .toBe('2026-10-14T05:00:00.000Z');
  });

  it('does Tomorrow, a picked date, and no date', () => {
    expect(resolveDueChoice({ when: 'tomorrow' }, now, CHI)!.toISOString())
      .toBe('2026-10-15T05:00:00.000Z');
    expect(resolveDueChoice({ when: 'date', date: '2026-12-24' }, now, CHI)!.toISOString())
      .toBe('2026-12-24T06:00:00.000Z');
    expect(resolveDueChoice({ when: 'none', date: '2026-12-24', time: '09:00' }, now, CHI))
      .toBeNull();
  });

  it('adds a time only when one is given', () => {
    expect(resolveDueChoice({ when: 'today', time: '21:30' }, now, CHI)!.toISOString())
      .toBe('2026-10-15T02:30:00.000Z');
    expect(resolveDueChoice({ when: 'today', time: '' }, now, CHI)!.toISOString())
      .toBe('2026-10-14T05:00:00.000Z');
  });

  it('returns an Invalid Date for a picked date that is missing or nonsense', () => {
    expect(Number.isNaN(resolveDueChoice({ when: 'date', date: '' }, now, CHI)!.getTime())).toBe(true);
    expect(Number.isNaN(resolveDueChoice({ when: 'date', date: '2026-02-31' }, now, CHI)!.getTime())).toBe(true);
  });
});

describe('describeDueChoice', () => {
  const now = new Date('2026-10-14T14:07:00Z');

  it('prefills the edit form so saving it unchanged moves nothing', () => {
    for (const iso of ['2026-10-14T05:00:00Z', '2026-10-15T02:30:00Z', '2026-12-24T06:00:00Z', '2026-10-15T19:00:00Z']) {
      const due = new Date(iso);
      const choice = describeDueChoice(due, now, CHI);
      expect(resolveDueChoice(choice, now, CHI)!.toISOString()).toBe(due.toISOString());
    }
  });

  it('reads a midnight due date as a day with no time', () => {
    expect(describeDueChoice(new Date('2026-10-14T05:00:00Z'), now, CHI))
      .toEqual({ when: 'today', date: '2026-10-14', time: '' });
    expect(describeDueChoice(new Date('2026-10-15T19:00:00Z'), now, CHI))
      .toEqual({ when: 'tomorrow', date: '2026-10-15', time: '14:00' });
    expect(describeDueChoice(null, now, CHI).when).toBe('none');
  });
});
