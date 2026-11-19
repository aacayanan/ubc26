"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Suspense } from "react";
import { useEffect, useState } from "react";

interface CompetitionDetail {
  id: string;
  title: string;
  challenge_text: string;
  challenge_preview: string;
  models: { id: string; name: string }[];
  deadline: string;
  status: string;
  potential_points: number;
  user_prediction: {
    accuracy: string | null;
    speed: string | null;
    code_length: string | null;
  } | null;
}

function CompetitionDetailContent() {
  const params = useParams();
  const router = useRouter();
  const compId = params.id as string;

  const [competition, setCompetition] = useState<CompetitionDetail | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prediction picks
  const [accuracyPick, setAccuracyPick] = useState<string>("");
  const [speedPick, setSpeedPick] = useState<string>("");
  const [lengthPick, setLengthPick] = useState<string>("");

  useEffect(() => {
    // TODO: fetch from API — GET /api/competitions/[id]
    // const fetchCompetition = async () => {
    //   const res = await fetch(`/api/competitions/${compId}`);
    //   const data = await res.json();
    //   setCompetition(data);
    //   setAccuracyPick(data.user_prediction?.accuracy ?? "");
    //   setSpeedPick(data.user_prediction?.speed ?? "");
    //   setLengthPick(data.user_prediction?.code_length ?? "");
    // };
    // fetchCompetition();
    setLoading(false);
  }, [compId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // TODO: POST /api/competitions/[id]/predictions
      // await fetch(`/api/competitions/${compId}/predictions`, {
      //   method: "POST",
      //   headers: { "Content-Type": "application/json" },
      //   body: JSON.stringify({
      //     accuracy: accuracyPick,
      //     speed: speedPick,
      //     code_length: lengthPick,
      //   }),
      // });
      router.push("/dashboard");
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to submit prediction",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading || !competition) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-zinc-500">
          {loading ? "Loading…" : "Competition not found."}
        </p>
      </div>
    );
  }

  const isLocked = competition.status === "LOCKED";
  const isSubmitted =
    competition.user_prediction &&
    competition.user_prediction.accuracy &&
    competition.user_prediction.speed &&
    competition.user_prediction.code_length;

  return (
    <div className="flex flex-1 items-start justify-center px-4 py-10 sm:px-6">
      <div className="w-full max-w-3xl space-y-6">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href="/competitions"
            className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
          >
            Competitions
          </Link>
          <span className="text-zinc-300 dark:text-zinc-700">/</span>
          <span className="font-medium text-zinc-900 dark:text-zinc-50">
            {competition.title}
          </span>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
                {competition.title}
              </h1>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                Deadline: {new Date(competition.deadline).toLocaleString()}
              </p>
            </div>
            <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {competition.status}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3">
            {competition.models.map((m) => (
              <div
                key={m.id}
                className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2 text-center text-sm font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800/50 dark:text-zinc-300"
              >
                {m.name}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-50">
            Challenge Preview
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            {competition.challenge_text || competition.challenge_preview}
          </p>
        </div>

        {competition.status === "OPEN" && !isSubmitted ? (
          <form
            onSubmit={handleSubmit}
            className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-50">
              Submit Your Predictions
            </h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Pick the model you think will win each category. You can change
              your picks until the deadline.
            </p>

            <div className="mt-4 space-y-4">
              {(["accuracy", "speed", "code_length"] as const).map((cat) => (
                <div key={cat}>
                  <label className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {cat === "accuracy"
                      ? "Accuracy"
                      : cat === "speed"
                        ? "Speed"
                        : "Code Length"}
                  </label>
                  <select
                    value={
                      cat === "accuracy"
                        ? accuracyPick
                        : cat === "speed"
                          ? speedPick
                          : lengthPick
                    }
                    onChange={(e) => {
                      if (cat === "accuracy") setAccuracyPick(e.target.value);
                      else if (cat === "speed") setSpeedPick(e.target.value);
                      else setLengthPick(e.target.value);
                    }}
                    className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50 dark:focus:border-zinc-500"
                  >
                    <option value="">Select a model</option>
                    {competition.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {error && (
              <p className="mt-4 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={saving || !accuracyPick || !speedPick || !lengthPick}
              className="mt-6 w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:opacity-50"
            >
              {saving ? "Submitting…" : "Submit Predictions"}
            </button>
          </form>
        ) : isSubmitted ? (
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              ✓ Predictions submitted. You will be notified when results are
              available.
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {isLocked
                ? "Predictions are locked. Results are being prepared."
                : "Predictions are not currently open."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CompetitionDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-zinc-500">Loading competition…</p>
        </div>
      }
    >
      <CompetitionDetailContent />
    </Suspense>
  );
}
