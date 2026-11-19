"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface CatalogOption {
  id: string;
  name: string;
}

interface CompetitionFormProps {
  challenges: CatalogOption[];
  models: CatalogOption[];
}

export function CompetitionForm({ challenges, models }: CompetitionFormProps) {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [challengeId, setChallengeId] = useState(challenges[0]?.id ?? "");
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [deadline, setDeadline] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleModel(modelId: string) {
    setModelIds((current) =>
      current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId],
    );
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/competitions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          challengeId,
          modelIds,
          predictionDeadline: new Date(deadline).toISOString(),
        }),
      });
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body.error?.message ?? "Could not create competition");
      }

      router.push("/competitions");
      router.refresh();
    } catch (submissionError: unknown) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Could not create competition",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-6 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      {error && (
        <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      <label className="block text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          Competition name
        </span>
        <input
          required
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="python-list-comprehensions"
          className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
        />
      </label>

      <label className="block text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          Challenge
        </span>
        <select
          required
          value={challengeId}
          onChange={(event) => setChallengeId(event.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
        >
          <option value="" disabled>
            Select a published challenge
          </option>
          {challenges.map((challenge) => (
            <option key={challenge.id} value={challenge.id}>
              {challenge.name}
            </option>
          ))}
        </select>
      </label>

      <fieldset>
        <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Participating models
        </legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {models.map((model) => (
            <label
              key={model.id}
              className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700"
            >
              <input
                type="checkbox"
                checked={modelIds.includes(model.id)}
                onChange={() => toggleModel(model.id)}
              />
              {model.name}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Choose at least two models.
        </p>
      </fieldset>

      <label className="block text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          Prediction deadline
        </span>
        <input
          required
          type="datetime-local"
          value={deadline}
          onChange={(event) => setDeadline(event.target.value)}
          className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
        />
      </label>

      <button
        type="submit"
        disabled={submitting || challenges.length === 0 || models.length < 2}
        className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {submitting ? "Creating…" : "Create and open competition"}
      </button>
    </form>
  );
}
