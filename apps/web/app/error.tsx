"use client"; // Error boundaries must be Client Components

import { useEffect, useRef } from "react";
import { CrosshairMark } from "@/components/ui";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alertRef.current?.focus();
  }, []);

  return (
    <main
      id="main"
      className="shell flex flex-1 items-center justify-center py-20"
    >
      <div
        ref={alertRef}
        tabIndex={-1}
        className="w-full max-w-lg outline-none"
        role="alert"
      >
        <CrosshairMark className="size-11 text-faint" />
        <h1 className="t-display mt-7 text-[clamp(1.7rem,3.4vw,2.4rem)] text-ink">
          The signal dropped.
        </h1>
        <p className="t-body mt-3 text-sm text-muted">
          Something failed while this page was assembling. Nothing about your
          account or your stakes changed.
        </p>

        <div className="panel-quiet mt-7 flex items-center justify-between gap-4 px-4 py-3">
          <span className="t-label text-[0.5625rem] text-faint">Reference</span>
          <span className="t-mono truncate text-[0.6875rem] text-muted">
            {error?.digest ?? "unavailable"}
          </span>
        </div>

        <button
          type="button"
          onClick={() => reset()}
          className="btn btn-solid mt-6"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
