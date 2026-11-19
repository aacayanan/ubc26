"use client";

import { useState } from "react";
import NavLink from "@/components/nav-link";

interface MobileNavProps {
  variant: "marketing" | "app";
}

interface NavLinkItem {
  href: string;
  label: string;
}

const linksByVariant: Record<"marketing" | "app", NavLinkItem[]> = {
  marketing: [
    { href: "/", label: "Landing" },
    { href: "/leaderboard", label: "Leaderboard" },
    { href: "/models", label: "Models" },
    { href: "/competitions", label: "Competitions" },
  ],
  app: [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/competitions", label: "Competitions" },
    { href: "/leaderboard", label: "Leaderboard" },
    { href: "/models", label: "Models" },
    { href: "/profile", label: "Profile" },
  ],
};

export default function MobileNav({ variant }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const links = linksByVariant[variant];

  return (
    <div className="sm:hidden">
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="rounded-lg p-2 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className="size-5"
          aria-hidden="true"
        >
          {open ? (
            <>
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </>
          ) : (
            <>
              <path d="M4 7h16" />
              <path d="M4 12h16" />
              <path d="M4 17h16" />
            </>
          )}
        </svg>
      </button>

      {open && (
        <div className="absolute inset-x-0 top-full border-b border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <nav className="flex flex-col gap-1">
            {links.map((link) => (
              <NavLink key={link.href} href={link.href}>
                <span
                  className="block rounded-lg px-3 py-2"
                  onClick={() => setOpen(false)}
                >
                  {link.label}
                </span>
              </NavLink>
            ))}
          </nav>
        </div>
      )}
    </div>
  );
}
