import { Suspense } from "react";
import LinkWalletStep from "@/components/link-wallet-step";

export default function LinkWalletPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[calc(100svh-64px)] items-center justify-center px-5">
          <div
            className="panel w-full max-w-[420px] space-y-4 p-8"
            aria-busy="true"
          >
            <div className="skeleton h-7 w-56" />
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-4 w-3/4" />
            <div className="skeleton h-10 w-full rounded-full" />
          </div>
        </div>
      }
    >
      <LinkWalletStep redirectTo="/dashboard" />
    </Suspense>
  );
}
