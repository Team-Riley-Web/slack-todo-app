'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * The tick, answering the moment it is pressed.
 *
 * The row is a server component and the tick is a plain form posting a server
 * action, so the row only changed once the whole round trip had finished. That
 * gap is the delay. `useFormStatus` reports "submitted, not yet answered" the
 * instant the form posts, so this shows the OUTCOME right away -- the circle
 * takes its opposite look -- and the real row replaces it when the server
 * answers.
 *
 * Still a real submit button inside a real form: with no JavaScript the form
 * posts as before, it simply does not get the head start.
 *
 * `data-pending` also lets the stylesheet strike the title through at once
 * (`.row:has(button[data-pending])`), so the whole row reacts, not just the
 * circle. If the action fails the page re-renders from the server and the
 * optimistic look goes away on its own, because `pending` ends.
 */
export function TickButton({
  openClass, doneClass, isDone, label, hint, children,
}: {
  /** Classes for the open look (carries the priority colour). */
  openClass: string;
  doneClass: string;
  isDone: boolean;
  label: string;
  hint: string;
  children: ReactNode;
}) {
  const { pending } = useFormStatus();
  // While pending, show the opposite of where the row is now.
  const showDone = pending ? !isDone : isDone;
  return (
    <button
      type="submit"
      className={showDone ? doneClass : openClass}
      data-pending={pending ? (isDone ? 'reopen' : 'complete') : undefined}
      aria-label={label}
      title={hint}
    >
      {children}
    </button>
  );
}
