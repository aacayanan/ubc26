import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { needsAccountSetup } from "@/lib/auth/wallet-account";

const PROTECTED = [
  "/admin",
  "/dashboard",
  "/predictions",
  "/profile",
  "/link-wallet",
  "/create-account",
];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    return response;
  }

  const supabase = createServerClient(supabaseUrl, publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        // Write refreshed tokens onto the request first: NextResponse snaps
        // the override-headers (x-middleware-request-*) when constructed, so
        // the recreated response below re-snapshots the updated headers.
        list.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  // getUser() verifies the session server-side; an expired token is refreshed
  // through setAll above before the verdict lands.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );

  // A Phantom sign-up finishes by choosing a username and password; until it
  // has, every signed-in page sends it to /create-account.
  const setupPending = needsAccountSetup(user);
  if (
    setupPending &&
    (isProtected || path === "/login") &&
    path !== "/create-account"
  ) {
    return NextResponse.redirect(new URL("/create-account", request.url));
  }
  if (user && !setupPending && path === "/create-account") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (user && path === "/login") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (!user && isProtected) {
    const login = new URL("/login", request.url);
    // Same-origin absolute path only (matches the login form's validation).
    login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
