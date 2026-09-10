import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Team Riley Tasks',
  description: 'Task console for Team Riley',
  /**
   * Declared here rather than through the `app/icon.png` file convention, so
   * the same 512px source serves the tab icon, the iOS home-screen icon and
   * the header logo. The convention would need a second copy of the file, and
   * two copies of an image drift.
   */
  icons: {
    icon: '/tasks-logo.png',
    shortcut: '/tasks-logo.png',
    apple: '/tasks-logo.png',
  },
};

// Readable on a phone without pinch-zooming.
export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
