import type { Metadata } from "next";
import { Barlow, JetBrains_Mono, Rajdhani } from "next/font/google";
import "./globals.css";
import Header from "@/components/header";
import { MobileTabBar, NavRail } from "@/components/nav";
import { QuickAskProvider } from "@/components/quick-ask";
import { createClient } from "@/utils/supabase/server";

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

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <html
      lang="en"
      className={`${barlow.variable} ${rajdhani.variable} ${jetBrainsMono.variable} h-full antialiased`}
    >
      {/* Navigation shell (M1-8): the icon rail is fixed on desktop, the tab
          bar fixed at the bottom on mobile; the content clears both. The
          header (M1-9) sits above the page content. The QuickAskProvider
          (M1-10b) wraps both the header and the page content so the
          quick-ask bar can hand a message to the Chat screen in client
          state, never in the URL. */}
      <body className="min-h-full">
        <QuickAskProvider>
          <NavRail />
          <div className="pb-16 md:pb-0 md:pl-[88px]">
            <Header userEmail={user?.email ?? null} />
            {children}
          </div>
          <MobileTabBar />
        </QuickAskProvider>
      </body>
    </html>
  );
}
