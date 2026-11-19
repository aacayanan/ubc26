export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center gap-10 py-24 text-center sm:py-32">
        <div className="space-y-4">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 sm:text-5xl">
            Predict the Best LLM
          </h1>
          <p className="mx-auto max-w-lg text-lg text-zinc-600 dark:text-zinc-400">
            Watch GPT, Claude, and Gemini solve coding challenges. Place your
            predictions on accuracy, speed, and code length before the clock
            runs out.
          </p>
        </div>
        <div className="flex gap-4">
          <a
            href="/login"
            className="rounded-full bg-zinc-900 px-6 py-3 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Get Started
          </a>
          <a
            href="/leaderboard"
            className="rounded-full border border-zinc-200 px-6 py-3 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            View Leaderboard
          </a>
        </div>
        <div className="grid w-full grid-cols-1 gap-6 pt-8 sm:grid-cols-3">
          {[
            {
              title: "Accuracy",
              desc: "Which model passes the most tests?",
            },
            {
              title: "Speed",
              desc: "Who writes and runs code fastest?",
            },
            {
              title: "Code Length",
              desc: "Who solves it with the cleanest code?",
            },
          ].map((item) => (
            <div
              key={item.title}
              className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
                {item.title}
              </h3>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
