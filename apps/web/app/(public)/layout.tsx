import SiteHeader from "@/components/site-header";

export default function PublicLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader variant="marketing" />
      {children}
      <footer className="border-t border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-6 text-xs text-zinc-500 sm:px-6 dark:text-zinc-400">
          <span>AI Showdown</span>
          <span>Points and leaderboards only — no real money.</span>
        </div>
      </footer>
    </>
  );
}
