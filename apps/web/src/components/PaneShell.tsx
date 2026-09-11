'use client';

import { useRef } from 'react';
import { useRouter } from 'next/navigation';

/** Must match the .pane-shell.leaving animation in globals.css. */
const EXIT_MS = 150;

/**
 * Plays the pane's exit animation before the pane goes away.
 *
 * The problem: a pane is removed from the tree when its query parameter goes,
 * and CSS cannot animate an element that no longer exists. React's
 * <ViewTransition> exists to solve exactly this, and is genuinely unavailable
 * here -- verified by probe, it is undefined on both the server and the
 * client even with Next's experimental.viewTransition flag on, because the
 * flag swaps Next's own internals rather than what app code imports.
 *
 * So this does the obvious thing instead: animate the pane out FIRST, while
 * it is still in the DOM, and only then let the navigation happen. No view
 * transitions, no experimental React, no snapshotting.
 *
 * The two exits are different and are handled differently:
 *
 * - Closing (×, Cancel, or the backdrop) is a client-side navigation, which
 *   is fast enough to beat the animation and cut it off. So the navigation is
 *   held for the length of the animation and then pushed.
 *
 * - Saving posts a server action and cannot be held: the round trip is the
 *   slow part, and delaying it would only make saving feel slower. The exit
 *   is started immediately and the submit proceeds underneath, so the pane
 *   has visually left by the time the server answers and React unmounts it.
 *
 * Without JavaScript the links are still ordinary links and the form is still
 * an ordinary form: everything works exactly as before, minus the motion.
 */
export function PaneShell({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  // Guards a double-trigger: a second click during the exit would push twice.
  const leaving = useRef(false);

  const startLeaving = () => {
    if (leaving.current) return false;
    leaving.current = true;
    ref.current?.classList.add('leaving');
    return true;
  };

  return (
    <div
      ref={ref}
      className="pane-shell"
      onClickCapture={(event) => {
        // Only a link that closes the pane; option links inside it navigate
        // normally, and a modified click must keep opening a new tab.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
          'a[data-pane-close]'
        );
        if (!link) return;
        const href = link.getAttribute('href');
        if (!href) return;
        event.preventDefault();
        if (!startLeaving()) return;
        window.setTimeout(() => router.push(href), EXIT_MS);
      }}
      onSubmitCapture={() => {
        // Not prevented: the action still runs. This only starts the exit so
        // the pane is gone from view by the time the redirect lands.
        startLeaving();
      }}
    >
      {children}
    </div>
  );
}
