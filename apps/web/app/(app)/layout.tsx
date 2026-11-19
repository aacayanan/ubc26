import { Suspense } from "react";
import SiteHeader from "@/components/site-header";
import { requireUser } from "@/lib/server/services/auth/session";

async function AuthGate({ children }: { children: React.ReactNode }) {
  await requireUser();
  return <>{children}</>;
}

function AppShellSkeleton() {
  return (
    <div className="shell py-12 sm:py-14" aria-busy="true" role="status">
      <span className="sr-only">Loading…</span>
      <div className="skeleton h-8 w-52" />
      <div className="skeleton mt-3 h-4 w-72" />
      <div className="skeleton mt-8 h-24 w-full rounded-[18px]" />
      <div className="skeleton mt-3 h-40 w-full rounded-[18px]" />
    </div>
  );
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader variant="app" />
      <main id="main" className="flex flex-1 flex-col">
        <Suspense fallback={<AppShellSkeleton />}>
          <AuthGate>{children}</AuthGate>
        </Suspense>
      </main>
    </>
  );
}
