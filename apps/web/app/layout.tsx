import type { Metadata } from "next";
import { Azeret_Mono, Host_Grotesk } from "next/font/google";
import Atmosphere from "@/components/atmosphere";
import "./globals.css";

const host = Host_Grotesk({
  variable: "--font-host",
  subsets: ["latin"],
  display: "swap",
});

const azeret = Azeret_Mono({
  variable: "--font-azeret",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "AI Showdown — three models, one brief, the crowd decides",
    template: "%s — AI Showdown",
  },
  description:
    "Watch three language models write the same creative brief and render it live. Predict with Devnet SOL before the deadline, then vote on which result is best. Devnet test SOL only — no real money.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${host.variable} ${azeret.variable} h-full antialiased`}
    >
      <body className="flex min-h-svh flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-void"
        >
          Skip to content
        </a>
        <Atmosphere />
        <div id="content" className="relative z-10 flex flex-1 flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
