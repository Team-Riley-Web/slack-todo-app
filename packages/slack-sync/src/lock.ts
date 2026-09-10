/**
 * One in-flight interaction per card, serialized.
 *
 * Two toggles on the same message otherwise interleave read-modify-render: both
 * read state, both mutate, both call chat.update, and whichever HTTP call lands
 * last wins the rendered message — which may be the one that read older state.
 * The database stays correct; the card can be left showing the wrong thing.
 *
 * Socket Mode holds one connection per process, so a per-process queue makes
 * per-card handling fully serial. With several app instances each keeps its own
 * queue; ordering is then only guaranteed within an instance.
 */
const cardLocks = new Map<string, Promise<void>>();

export async function withCardLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = cardLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => mine);
  cardLocks.set(key, chained);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    // Leave the entry in place if another interaction queued behind us.
    if (cardLocks.get(key) === chained) cardLocks.delete(key);
  }
}
