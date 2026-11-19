import { Suspense } from "react";
import LinkWalletStep from "@/components/link-wallet-step";

export default function LinkWalletPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900 dark:border-zinc-700 dark:border-t-zinc-50" />
        </div>
      }
    >
      <LinkWalletStep redirectTo="/dashboard" />
    </Suspense>
  );
}
