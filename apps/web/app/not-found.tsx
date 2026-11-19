import Link from "next/link";
import Logo from "@/components/logo";
import SiteHeader from "@/components/site-header";
import { CrosshairMark } from "@/components/ui";

export default function NotFound() {
  return (
    <>
      <SiteHeader variant="marketing" />
      <main id="main" className="flex flex-1 flex-col">
        <div className="shell flex flex-1 flex-col items-center justify-center py-20 text-center">
          <CrosshairMark className="size-12 text-faint" />
          <p className="t-mono mt-8 text-[0.6875rem] tracking-[0.24em] text-faint">
            404
          </p>
          <h1 className="t-display mt-3 text-[clamp(1.9rem,4vw,3rem)] text-ink">
            Nothing rendered here.
          </h1>
          <p className="t-body mt-4 max-w-[42ch] text-sm text-muted">
            The page you asked for doesn&apos;t exist or has moved. The arena is
            still running.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/" className="btn btn-primary btn-sm">
              Back home
            </Link>
            <Link href="/competitions" className="btn btn-ghost btn-sm">
              Open rounds
            </Link>
          </div>
        </div>
      </main>
      <footer className="border-t border-hairline">
        <div className="shell flex items-center justify-between py-5">
          <Logo />
          <span className="t-mono text-[0.625rem] tracking-[0.1em] text-faint">
            SOLANA DEVNET
          </span>
        </div>
      </footer>
    </>
  );
}
