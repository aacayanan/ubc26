// Generic root Suspense fallback: minimal pulsing blocks that read sensibly
// on any route (landing, leaderboard, etc.) while the segment streams in.
export default function RootLoading() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-3xl space-y-6" aria-busy="true">
        <div className="h-8 w-48 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
        <div className="h-4 w-72 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
        <div className="h-32 w-full animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
