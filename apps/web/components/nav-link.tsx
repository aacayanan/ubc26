"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface NavLinkProps {
  href: string;
  children: ReactNode;
  block?: boolean;
}

export default function NavLink({
  href,
  children,
  block = false,
}: NavLinkProps) {
  const pathname = usePathname();
  const isActive =
    pathname === href || (href !== "/" && pathname.startsWith(href + "/"));

  if (block) {
    return (
      <Link
        href={href}
        aria-current={isActive ? "page" : undefined}
        className={
          isActive
            ? "flex items-center gap-2.5 rounded-lg bg-white/[0.04] px-3 py-2.5 text-sm text-ink"
            : "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-muted hover:bg-white/[0.03] hover:text-ink"
        }
      >
        <span
          aria-hidden="true"
          className={`dot ${isActive ? "dot-live" : "dot-idle"}`}
        />
        {children}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={`t-label relative py-1 transition-colors duration-200 ${
        isActive ? "text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {children}
      <span
        aria-hidden="true"
        className={`absolute -bottom-1.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-magenta transition-opacity duration-200 ${
          isActive ? "opacity-100" : "opacity-0"
        }`}
      />
    </Link>
  );
}
