// Route-level Suspense fallback under cacheComponents: mirrors the real
// dashboard layout (header, 4 stat tiles, competitions box, quick links).
export default function DashboardLoading() {
  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-4xl space-y-8" aria-busy="true">
        {/* Header */}
        <div className="space-y-2">
          <div className="h-7 w-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-4 w-64 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
        </div>

        {/* Quick stats: 4 tiles */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800"
            />
          ))}
        </div>

        {/* Active competitions box */}
        <div className="space-y-3">
          <div className="h-4 w-44 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
        </div>

        {/* Quick links */}
        <div className="space-y-3">
          <div className="h-4 w-32 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-12 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
