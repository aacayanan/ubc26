"use client";

import { useEffect, useRef, useState } from "react";
import NavLink from "@/components/nav-link";
import { appDrawerNav, marketingNav } from "@/components/nav-items";

interface MobileNavProps {
  variant: "marketing" | "app";
}

export default function MobileNav({ variant }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const links = variant === "app" ? appDrawerNav : marketingNav;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="sm:hidden">
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        ref={buttonRef}
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((value) => !value)}
        className="-ml-1 grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-white/[0.04] hover:text-ink"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
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
              <path d="M4 17h10" />
            </>
          )}
        </svg>
      </button>

      {open ? (
        <div
          id="mobile-menu"
          className="absolute inset-x-0 top-full border-b border-hairline bg-[rgb(5_4_10/0.96)] px-3 pb-4 pt-2 backdrop-blur-xl"
        >
          <nav aria-label="Mobile" className="flex flex-col gap-0.5">
            {links.map((link) => (
              <div key={link.href} onClick={() => setOpen(false)}>
                <NavLink href={link.href} block>
                  {link.label}
                </NavLink>
              </div>
            ))}
          </nav>
        </div>
      ) : null}
    </div>
  );
}
