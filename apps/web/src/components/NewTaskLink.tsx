'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The New task button, which also gets the phone keyboard open.
 *
 * iOS Safari only raises the keyboard when an input is focused INSIDE the tap
 * that caused it. The pane arrives a moment after the tap (a navigation, then a
 * render), so the title's `autoFocus` lands too late: the field is focused but
 * no keyboard appears, and you have to tap it again.
 *
 * The standard workaround: on the tap itself, focus a throwaway input, which
 * opens the keyboard now. When the pane renders, `autoFocus` moves focus to the
 * title -- and iOS keeps the keyboard up when focus moves from one input to
 * another. The throwaway is removed as soon as focus has left it, or after a
 * few seconds if the pane never comes. On a desktop this is invisible.
 */
export function NewTaskLink({
  href, className, children,
}: { href: string; className?: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={className}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const proxy = document.createElement('input');
        proxy.type = 'text';
        proxy.setAttribute('aria-hidden', 'true');
        proxy.tabIndex = -1;
        // 16px so iOS does not zoom; off-screen but still focusable.
        proxy.style.cssText =
          'position:fixed;top:0;left:-1000px;width:1px;height:1px;opacity:0;font-size:16px;';
        document.body.appendChild(proxy);
        proxy.focus();
        const remove = () => proxy.remove();
        proxy.addEventListener('blur', remove, { once: true });
        window.setTimeout(remove, 5000);
      }}
    >
      {children}
    </Link>
  );
}
