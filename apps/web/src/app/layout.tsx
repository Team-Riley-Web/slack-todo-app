import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Team Riley Tasks',
  description: 'Task console for Team Riley',
  /**
   * Declared here rather than through the `app/icon.png` file convention, so
   * the 512px circle logo serves the tab icon and the header logo from one
   * file. The iOS home-screen icon is its own square, full-bleed image: iOS
   * masks icons to a rounded square, and the circle left a white ring.
   */
  icons: {
    icon: '/tasks-logo.png',
    shortcut: '/tasks-logo.png',
    apple: '/apple-touch-icon.png',
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
