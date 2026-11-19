import Link from "next/link";
import { Suspense } from "react";
import HeaderUserArea from "@/components/header-user-area";
import MobileNav from "@/components/mobile-nav";
import NavLink from "@/components/nav-link";

interface SiteHeaderProps {
  variant: "marketing" | "app";
}

interface NavLinkItem {
  href: string;
  label: string;
}

const linksByVariant: Record<"marketing" | "app", NavLinkItem[]> = {
  marketing: [
    { href: "/leaderboard", label: "Leaderboard" },
    { href: "/models", label: "Models" },
  ],
  app: [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/competitions", label: "Competitions" },
    { href: "/leaderboard", label: "Leaderboard" },
    { href: "/models", label: "Models" },
  ],
};

export default function SiteHeader({ variant }: SiteHeaderProps) {
  const logoHref = variant === "app" ? "/dashboard" : "/";
  const links = linksByVariant[variant];

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <nav className="relative mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <MobileNav variant={variant} />
          <Link
            href={logoHref}
            className="whitespace-nowrap text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
          >
            AI Showdown
          </Link>
        </div>

        <div className="hidden items-center gap-6 sm:flex">
          {links.map((link) => (
            <NavLink key={link.href} href={link.href}>
              {link.label}
            </NavLink>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Suspense
            fallback={
              <div className="h-8 w-24 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
            }
          >
            <HeaderUserArea variant={variant} />
          </Suspense>
        </div>
      </nav>
    </header>
  );
}
