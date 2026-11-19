"use client"; // Error boundaries must be Client Components

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-4xl space-y-4" role="alert">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Something went wrong
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            An unexpected error occurred. You can try again.
          </p>
        </div>

        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-950/50 dark:text-red-400">
          {error?.message ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">
              {error.message}
            </pre>
          ) : (
            <p>No additional details are available.</p>
          )}
          {error?.digest && (
            <p className="mt-2 font-mono text-xs opacity-70">
              Reference: {error.digest}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => reset()}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
