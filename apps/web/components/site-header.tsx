import { Suspense } from "react";
import { connection } from "next/server";
import HeaderUserArea from "@/components/header-user-area";
import Logo from "@/components/logo";
import MobileNav from "@/components/mobile-nav";
import NavLink from "@/components/nav-link";
import {
  getSignedInDrawerNav,
  getSignedInNav,
  marketingNav,
  type NavItem,
} from "@/components/nav-items";
import { getAuthenticatedUser } from "@/lib/server/auth";

interface SiteHeaderProps {
  variant: "marketing" | "app";
}

export default async function SiteHeader({ variant }: SiteHeaderProps) {
  await connection();
  const authenticatedUser = await getAuthenticatedUser();
  const logoHref = variant === "app" ? "/dashboard" : "/";
  const isAuthenticated = authenticatedUser !== null;
  const isAdmin = authenticatedUser?.role === "admin";
  const desktopLinks: NavItem[] = isAuthenticated
    ? getSignedInNav(isAdmin)
    : marketingNav;
  const mobileLinks: NavItem[] = isAuthenticated
    ? getSignedInDrawerNav(isAdmin)
    : marketingNav;

  return (
    <header className="sticky top-0 z-50 border-b border-hairline bg-[rgb(5_4_10/0.72)] backdrop-blur-xl">
      <div className="shell flex h-16 items-center justify-between gap-3 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <MobileNav links={mobileLinks} />
          <Logo href={logoHref} />
        </div>

        <nav aria-label="Primary" className="hidden items-center gap-9 sm:flex">
          {desktopLinks.map((link) => (
            <NavLink key={link.href} href={link.href}>
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center justify-end gap-2">
          <Suspense
            fallback={
              <div
                role="status"
                aria-busy="true"
                className="skeleton h-8 w-24 rounded-full"
              >
                <span className="sr-only">Loading account…</span>
              </div>
            }
          >
            <HeaderUserArea variant={variant} />
          </Suspense>
        </div>
      </div>
    </header>
  );
}
