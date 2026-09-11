import { describe, it, expect } from 'vitest';
import { capitalizeFirstLetter as cap } from './capitalize.js';

describe('what it capitalises', () => {
  it('raises a lowercase opening word', () => {
    expect(cap('call neil about the amp')).toBe('Call neil about the amp');
    expect(cap('fix the sticky header')).toBe('Fix the sticky header');
  });

  it('changes exactly one character and nothing else', () => {
    const raw = 'offer Neil Instagram and Facebook package for $100';
    expect(cap(raw)).toBe('Offer Neil Instagram and Facebook package for $100');
    expect(cap(raw).slice(1)).toBe(raw.slice(1));
  });

  it('handles a one-letter and one-word title', () => {
    expect(cap('x')).toBe('X');
    expect(cap('invoice')).toBe('Invoice');
  });

  it('capitalises an accented opening letter', () => {
    expect(cap('émile needs the brief')).toBe('Émile needs the brief');
  });
});

describe('what it leaves alone', () => {
  it('a title that is already capitalised', () => {
    expect(cap('Call Neil')).toBe('Call Neil');
  });

  /**
   * The reason this function is cautious rather than clever. Getting these
   * wrong would rewrite the user's own words, which is worse than a scruffy list.
   */
  it('a word that carries its own capitalisation', () => {
    expect(cap('iPhone screen repair')).toBe('iPhone screen repair');
    expect(cap('eBay listing for the amp')).toBe('eBay listing for the amp');
    expect(cap('macOS upgrade for Rachael')).toBe('macOS upgrade for Rachael');
    expect(cap('jQuery removal')).toBe('jQuery removal');
  });

  it('an identifier: a path, a domain, a URL, a handle', () => {
    expect(cap('src/index.ts needs a fix')).toBe('src/index.ts needs a fix');
    expect(cap('github.com/TheRileyBird is stale')).toBe('github.com/TheRileyBird is stale');
    expect(cap('https://example.com is down')).toBe('https://example.com is down');
    expect(cap('joshua@ziffmedia.com bounced')).toBe('joshua@ziffmedia.com bounced');
    expect(cap('package.json bump')).toBe('package.json bump');
  });

  it('a title that does not open with a letter', () => {
    expect(cap('3 quotes for the barn')).toBe('3 quotes for the barn');
    expect(cap('#productiontask launch')).toBe('#productiontask launch');
    expect(cap('“quoted” task')).toBe('“quoted” task');
    expect(cap('🔥 urgent thing')).toBe('🔥 urgent thing');
  });

  it('an empty string', () => {
    expect(cap('')).toBe('');
  });
});

describe('safety properties', () => {
  it('never changes the length in code points', () => {
    for (const raw of [
      'call neil', 'iPhone repair', '🔥 urgent', 'émile', 'x', 'src/a.ts fix',
    ]) {
      expect([...cap(raw)]).toHaveLength([...raw].length);
    }
  });

  it('is idempotent', () => {
    for (const raw of ['call neil', 'iPhone repair', '3 quotes', 'Already up']) {
      expect(cap(cap(raw))).toBe(cap(raw));
    }
  });

  it('does not depend on the host locale for the Turkish dotted i', () => {
    // toLocaleUpperCase('tr') maps "i" to "İ"; this must not.
    expect(cap('invoice Neil')).toBe('Invoice Neil');
  });
});
