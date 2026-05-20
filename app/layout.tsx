import './globals.css';
import logo from './public/logo.png';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'AgentDiagram: diagram-as-code',
  description: 'Open-source local diagram-as-code editor and agentic repo explorer.',
  // Motivation vs Logic: reuse the same logo asset for the document icon so the tab/favicon matches the header brand mark.
  icons: {
    icon: logo.src,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ink-950 text-ink-100">{children}</body>
    </html>
  );
}
