import Link from "next/link";
import { getCurrentUser } from "@/lib/server/services/auth/session";
import SignOutButton from "@/components/sign-out-button";

interface HeaderUserAreaProps {
  variant: "marketing" | "app";
}

export default async function HeaderUserArea({ variant }: HeaderUserAreaProps) {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <Link
        href="/login"
        className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        Sign in
      </Link>
    );
  }

  const initial = (user.email?.[0] ?? "U").toUpperCase();
  const name = user.email?.split("@")[0];
  const nameClass =
    "min-w-0 max-w-28 truncate text-sm text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-50";

  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="hidden size-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-700 sm:flex dark:bg-zinc-800 dark:text-zinc-300"
      >
        {initial}
      </span>
      {variant === "app" ? (
        <Link href="/profile" className={nameClass}>
          {name}
        </Link>
      ) : (
        <span className={nameClass}>{name}</span>
      )}
      <SignOutButton />
    </div>
  );
}
