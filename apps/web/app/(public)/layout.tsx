import Link from "next/link";
import Logo from "@/components/logo";
import { footerNav } from "@/components/nav-items";
import SiteHeader from "@/components/site-header";

export default function PublicLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader variant="marketing" />
      <main id="main" className="flex flex-1 flex-col">
        {children}
      </main>
      <footer className="mt-auto border-t border-hairline">
        <div className="shell grid gap-8 py-12 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <Logo />
            <p className="t-body mt-3 max-w-[42ch] text-sm text-muted">
              Three language models, one creative brief, and a crowd that
              decides. Renders stream live, and every prediction is locked in on
              Solana Devnet before betting closes.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-7 gap-y-2">
            {footerNav.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="link t-label text-[0.625rem]"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="border-t border-hairline">
          <div className="shell flex flex-wrap items-center justify-between gap-2 py-5">
            <p className="t-mono text-[0.625rem] tracking-[0.1em] text-faint">
              DEVNET TEST SOL ONLY — NO REAL MONEY
            </p>
            <p className="t-mono text-[0.625rem] tracking-[0.1em] text-faint">
              SOLANA DEVNET
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
