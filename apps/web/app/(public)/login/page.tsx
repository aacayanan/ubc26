import type { Metadata } from "next";
import { Suspense } from "react";
import VortexField from "@/components/vortex-field";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <div className="grid flex-1 lg:grid-cols-[1.05fr_1fr]">
      {/* Statement side — the field, held still */}
      <div className="relative hidden overflow-hidden border-r border-hairline lg:block">
        <VortexField className="opacity-85" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{
            background:
              "linear-gradient(180deg, rgba(5,4,10,0.55) 0%, transparent 34%, rgba(5,4,10,0.72) 100%)",
          }}
        />
        <div className="relative z-10 flex h-full flex-col justify-end p-12">
          <p className="t-display max-w-[13ch] text-[clamp(2rem,3.2vw,3rem)] text-ink">
            Three models write the same brief.
          </p>
          <p className="t-body mt-5 max-w-[34ch] text-sm text-muted">
            Predict with Devnet SOL before the clock stops. Then watch what they
            drew, and vote on which one was best.
          </p>
          <p className="t-mono mt-10 text-[0.625rem] tracking-[0.14em] text-faint">
            DEVNET TEST SOL ONLY · NO REAL MONEY
          </p>
        </div>
      </div>

      {/* Form side */}
      <div className="flex items-center justify-center px-5 py-16 sm:px-8">
        <Suspense
          fallback={
            <div className="w-full max-w-[380px] space-y-4" aria-busy="true">
              <div className="skeleton h-9 w-40" />
              <div className="skeleton h-4 w-56" />
              <div className="skeleton h-11 w-full rounded-[10px]" />
              <div className="skeleton h-11 w-full rounded-[10px]" />
              <div className="skeleton h-11 w-full rounded-full" />
            </div>
          }
        >
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
