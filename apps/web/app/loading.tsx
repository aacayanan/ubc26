// Generic root Suspense fallback: reads sensibly on any route while the
// segment streams in.
export default function RootLoading() {
  return (
    <main
      id="main"
      className="shell flex flex-1 items-center justify-center py-20"
      aria-busy="true"
      role="status"
    >
      <span className="sr-only">Loading…</span>
      <div className="w-full max-w-3xl space-y-5">
        <div className="skeleton h-3 w-20" />
        <div className="skeleton h-8 w-64" />
        <div className="skeleton h-4 w-80" />
        <div className="skeleton h-36 w-full rounded-[18px]" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-24 rounded-[18px]" />
          ))}
        </div>
      </div>
    </main>
  );
}
