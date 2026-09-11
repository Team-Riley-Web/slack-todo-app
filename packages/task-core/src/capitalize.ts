/**
 * Sentence-cases a captured task, and knows when not to.
 *
 * The system's rule has been that a title keeps every byte you typed. This is
 * the one deliberate exception, asked for on 2026-09-11: tasks typed in a hurry
 * come out lowercase and a list of them reads as scruffy. It applies at the two
 * write paths only -- capture and edit -- and it changes at most ONE character,
 * never the rest.
 *
 * The danger in "just uppercase the first letter" is that plenty of words are
 * lowercase on purpose, and mangling one is worse than leaving a list untidy:
 *
 *   "iPhone screen repair"      -> "IPhone screen repair"    wrong
 *   "eBay listing for the amp"  -> "EBay listing..."         wrong
 *   "macOS upgrade for Rachael" -> "MacOS upgrade..."        wrong
 *   "src/index.ts needs a fix"  -> "Src/index.ts..."         wrong
 *
 * So this is deliberately timid. Three things stop it, and when any of them
 * fires the string is returned untouched rather than guessed at. A title left
 * alone is a cosmetic miss; a title rewritten wrong is the user's own words
 * changed under them, which is the thing this codebase is most careful about.
 */

/** A word that carries its own capitalisation, e.g. iPhone, eBay, macOS, jQuery. */
function hasInnerCapital(word: string): boolean {
  return /\p{Lu}/u.test(word.slice(1));
}

/**
 * A word that is an identifier rather than prose: a URL, a domain, a filename,
 * a path, a handle. Case is often significant in these and never cosmetic.
 */
function looksLikeIdentifier(word: string): boolean {
  return word.includes('://')
    || word.includes('@')
    || word.includes('/')
    || word.includes('\\')
    // An internal dot with letters or digits either side: github.com, index.ts.
    || /\w\.\w/.test(word);
}

/**
 * Returns `text` with its first letter capitalised, or `text` unchanged when
 * that would be a guess. Never alters any character but the first.
 */
export function capitalizeFirstLetter(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  // The first code point, not the first UTF-16 unit -- `text[0]` on an emoji
  // is half a surrogate pair, and slicing there would corrupt the character.
  const first = [...text][0]!;

  // Only a lowercase letter is ever changed. A title opening with a digit,
  // punctuation, an emoji or an already-capital letter is left exactly as is.
  if (!/^\p{Ll}$/u.test(first)) return text;

  const word = text.split(/\s/, 1)[0] ?? '';
  if (hasInnerCapital(word) || looksLikeIdentifier(word)) return text;

  // toUpperCase, not toLocaleUpperCase: under a Turkish locale the latter maps
  // "i" to "İ", which would silently depend on the server's locale.
  return first.toUpperCase() + text.slice(first.length);
}
