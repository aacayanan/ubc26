// Route-level Suspense fallback: mirrors the operator console layout
// (page header, form panel, catalog panel).
export default function AdminLoading() {
  return (
    <div className="shell py-14 sm:py-16" aria-busy="true" role="status">
      <span className="sr-only">Loading the operator console…</span>
      <div className="space-y-10">
        <div className="space-y-3">
          <div className="skeleton h-8 w-64" />
          <div className="skeleton h-4 w-80" />
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr]">
          <div className="space-y-5">
            <div className="skeleton h-4 w-28" />
            <div className="skeleton h-[28rem] w-full rounded-[18px]" />
          </div>
          <div className="space-y-5">
            <div className="skeleton h-4 w-24" />
            <div className="skeleton h-64 w-full rounded-[18px]" />
          </div>
        </div>
      </div>
    </div>
  );
}
