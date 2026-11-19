// Route-level Suspense fallback under cacheComponents: mirrors the real
// dashboard layout (header, instrument strip, rounds box, link list).
export default function DashboardLoading() {
  return (
    <div className="shell py-12 sm:py-14" aria-busy="true" role="status">
      <span className="sr-only">Loading your dashboard…</span>
      <div className="space-y-10">
        <div className="space-y-3">
          <div className="skeleton h-8 w-56" />
          <div className="skeleton h-4 w-64" />
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[18px] border border-hairline bg-hairline sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-[rgb(11_9_18/0.62)] px-5 py-5">
              <div className="skeleton h-2.5 w-16" />
              <div className="skeleton mt-2.5 h-6 w-20" />
            </div>
          ))}
        </div>

        <div className="space-y-4">
          <div className="skeleton h-4 w-32" />
          <div className="skeleton h-40 w-full rounded-[18px]" />
        </div>

        <div className="space-y-4">
          <div className="skeleton h-4 w-36" />
          <div className="skeleton h-48 w-full rounded-[18px]" />
        </div>
      </div>
    </div>
  );
}
