"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Status } from "@/components/ui";

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
  const [name, setName] = useState("");
  const [challengeId, setChallengeId] = useState(challenges[0]?.id ?? "");
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [deadline, setDeadline] = useState("");
  const [feePercent, setFeePercent] = useState("5");
  const [stallSeconds, setStallSeconds] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

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
    setSuccess(null);

    const trimmedName = name.trim();
    if (trimmedName.length < 3 || trimmedName.length > 120) {
      setError("Game name must be between 3 and 120 characters.");
      setSubmitting(false);
      return;
    }
    if (!challengeId) {
      setError("Select a valid published challenge.");
      setSubmitting(false);
      return;
    }
    if (modelIds.length < 2) {
      setError("Choose at least two participating AI models.");
      setSubmitting(false);
      return;
    }
    if (modelIds.length > 3) {
      setError("Choose no more than three participating AI models.");
      setSubmitting(false);
      return;
    }
    if (new Set(modelIds).size !== modelIds.length) {
      setError("Each participating AI model must be selected only once.");
      setSubmitting(false);
      return;
    }
    if (!deadline) {
      setError("Select a betting deadline.");
      setSubmitting(false);
      return;
    }
    const deadlineDate = new Date(deadline);
    if (Number.isNaN(deadlineDate.getTime()) || deadlineDate <= new Date()) {
      setError("The betting deadline must be a valid future date and time.");
      setSubmitting(false);
      return;
    }

    try {
      const response = await fetch("/api/admin/competitions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          challengeId,
          modelIds,
          predictionDeadline: deadlineDate.toISOString(),
          // Every round is a Devnet SOL round (valueless test SOL).
          wageringMode: "devnet_sol",
          feeBps: Math.round(Number(feePercent) * 100),
          stallTimeoutSeconds:
            stallSeconds.trim() === "" ? null : Number(stallSeconds),
        }),
      });
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body.error?.message ?? "Could not create competition");
      }

      setSuccess(
        `${trimmedName} was created and opened. Predictions close at ${deadlineDate.toLocaleString()}.`,
      );
      setName("");
      setModelIds([]);
      setDeadline("");
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
    <form onSubmit={handleSubmit} className="panel space-y-6 p-5 sm:p-6">
      {error && (
        <div
          role="alert"
          className="rounded-[10px] border border-[rgb(255_46_147/0.30)] bg-[rgb(255_46_147/0.07)] px-4 py-3 text-sm text-magenta"
        >
          {error}
        </div>
      )}

      {success && (
        <div role="status" className="panel-quiet px-4 py-3">
          <Status tone="live" pulse>
            Game created
          </Status>
          <p className="t-body mt-2 text-sm text-muted">{success}</p>
        </div>
      )}

      <label className="block">
        <span className="t-label text-[0.625rem] text-faint">Game name</span>
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="GPT vs Claude vs Gemini — Python Challenge"
          className="mt-2 w-full rounded-[10px] border border-[rgb(255_255_255/0.30)] bg-white/[0.02] px-3.5 py-2.5 text-sm text-ink placeholder:text-faint"
        />
      </label>

      <label className="block">
        <span className="t-label text-[0.625rem] text-faint">Challenge</span>
        <select
          required
          value={challengeId}
          onChange={(event) => setChallengeId(event.target.value)}
          className="mt-2 w-full rounded-[10px] border border-[rgb(255_255_255/0.30)] bg-void-raised px-3.5 py-2.5 text-sm text-ink"
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
        <legend className="t-label text-[0.625rem] text-faint">
          Participating AI models
        </legend>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {models.map((model) => (
            <label
              key={model.id}
              className="flex cursor-pointer items-center gap-3 rounded-[12px] border border-hairline bg-white/[0.018] px-3.5 py-3 text-sm text-ink"
            >
              <input
                type="checkbox"
                checked={modelIds.includes(model.id)}
                onChange={() => toggleModel(model.id)}
                className="size-4 accent-[var(--violet)]"
              />
              {model.name}
            </label>
          ))}
        </div>
        <p className="t-mono mt-2 text-[0.625rem] text-faint">
          Choose 2–3 eligible active models. Selections must be unique.
        </p>
      </fieldset>

      <label className="block">
        <span className="t-label text-[0.625rem] text-faint">
          Betting deadline / challenge start
        </span>
        <input
          required
          type="datetime-local"
          value={deadline}
          onChange={(event) => setDeadline(event.target.value)}
          className="mt-2 w-full rounded-[10px] border border-[rgb(255_255_255/0.30)] bg-white/[0.02] px-3.5 py-2.5 text-sm text-ink"
        />
        <p className="t-mono mt-2 text-[0.625rem] text-faint">
          Predictions close at this selected time. The challenge starts in
          {` ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}.
        </p>
      </label>

      <fieldset className="space-y-3 rounded-xl border border-hairline p-4">
        <legend className="t-label px-1 text-[0.625rem] text-faint">
          Devnet SOL wagering
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="t-label text-[0.625rem] text-faint">
              Platform fee (%)
            </span>
            <input
              inputMode="decimal"
              value={feePercent}
              onChange={(event) => setFeePercent(event.target.value)}
              className="field t-num mt-2"
            />
          </label>
          <label className="block">
            <span className="t-label text-[0.625rem] text-faint">
              Stall safeguard (s, blank = off)
            </span>
            <input
              inputMode="numeric"
              value={stallSeconds}
              onChange={(event) => setStallSeconds(event.target.value)}
              className="field t-num mt-2"
            />
          </label>
        </div>
        <p className="t-mono text-[0.625rem] text-faint">
          The deadline above becomes the $5 ante deadline. Live betting runs
          during generation and closes when the first model reaches 75% of its
          output-token budget. Devnet test SOL only; it has no value.
        </p>
      </fieldset>

      <button
        type="submit"
        disabled={submitting || challenges.length === 0 || models.length < 2}
        className="btn btn-solid btn-block w-full"
      >
        {submitting ? "Creating game…" : "Create Game"}
      </button>
    </form>
  );
}
