import Link from "next/link";
import { ArrowRight } from "@/components/icons";
import SignOutButton from "@/components/sign-out-button";
import { getCurrentUser } from "@/lib/server/services/auth/session";

interface HeaderUserAreaProps {
  variant: "marketing" | "app";
}

export default async function HeaderUserArea({ variant }: HeaderUserAreaProps) {
  const user = await getCurrentUser();

  if (!user) {
    return (
      <Link href="/login" className="btn btn-primary btn-sm">
        Sign in
        <ArrowRight className="size-3.5 opacity-60" />
      </Link>
    );
  }

  const initial = (user.email?.[0] ?? "U").toUpperCase();
  const name = user.email?.split("@")[0] ?? "account";
  const nameClass =
    "hidden max-w-28 truncate text-[0.8125rem] text-muted transition-colors hover:text-ink sm:block";

  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-full border border-hairline bg-white/[0.05] text-[0.6875rem] font-medium tracking-wide text-ink"
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
