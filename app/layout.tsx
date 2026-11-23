import type { Metadata } from "next";
import { Barlow, JetBrains_Mono, Rajdhani } from "next/font/google";
import "./globals.css";

// DESIGN.md Section 4 (owner decision 2026-11-07): Barlow for body text,
// Rajdhani for titles/labels/logo/greeting, JetBrains Mono for timestamps,
// tool names and parameters. All SIL OFL 1.1, self-hosted via next/font.
const barlow = Barlow({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const rajdhani = Rajdhani({
  variable: "--font-rajdhani",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "FLASH",
  description: "FLASH — private, single-user personal AI assistant",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${barlow.variable} ${rajdhani.variable} ${jetBrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
