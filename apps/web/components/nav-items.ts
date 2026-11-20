/**
 * One nav source of truth. The header, the mobile drawer and the footer all
 * read from here so no route is reachable in one place and missing in another.
 */

export interface NavItem {
  href: string;
  label: string;
}

export const marketingNav: NavItem[] = [
  { href: "/competitions", label: "Rounds" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/models", label: "Models" },
  { href: "/results", label: "Results" },
];

/** The footer adds the trust page; the header bar has no room for it. */
export const footerNav: NavItem[] = [
  ...marketingNav,
  { href: "/on-chain", label: "What's on-chain" },
];

export function getSignedInNav(isAdmin: boolean): NavItem[] {
  return [
    ...marketingNav,
    ...(isAdmin ? [{ href: "/admin", label: "Admin Dashboard" }] : []),
    { href: "/dashboard", label: "Dashboard" },
  ];
}

/** The drawer can afford account-route links the desktop bar cannot. */
export function getSignedInDrawerNav(isAdmin: boolean): NavItem[] {
  return [
    ...getSignedInNav(isAdmin),
    { href: "/predictions", label: "My predictions" },
    { href: "/profile", label: "Profile" },
  ];
}
