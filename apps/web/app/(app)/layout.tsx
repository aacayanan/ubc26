import { Suspense } from "react";
import SiteHeader from "@/components/site-header";
import { requireUser } from "@/lib/server/services/auth/session";

async function AuthGate({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <>{children}</>;
}

function AppShellSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <div className="mb-6 h-8 w-48 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
      <div className="mb-4 h-4 w-full animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
      <div className="mb-4 h-4 w-3/4 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
      <div className="h-40 w-full animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
    </div>
  );
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader variant="app" />
      <Suspense fallback={<AppShellSkeleton />}>
        <AuthGate>{children}</AuthGate>
      </Suspense>
    </>
  );
}
