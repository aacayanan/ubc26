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

/** Signed-in nav. Same destinations, plus the dashboard. */
export const appNav: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  ...marketingNav,
];

/** The drawer can afford the account-route links the desktop bar cannot. */
export const appDrawerNav: NavItem[] = [
  ...appNav,
  { href: "/predictions", label: "My predictions" },
  { href: "/profile", label: "Profile" },
];
