"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface CatalogOption {
  id: string;
  name: string;
  meta: string;
}

interface CompetitionFormProps {
  briefs: CatalogOption[];
  models: CatalogOption[];
}

export default function CompetitionForm({
  briefs,
  models,
}: CompetitionFormProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [briefId, setBriefId] = useState(briefs[0]?.id ?? "");
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [deadline, setDeadline] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    name.trim().length >= 3 &&
    briefId !== "" &&
    modelIds.length >= 2 &&
    deadline !== "";

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
          slug: name.trim(),
          challengeId: briefId,
          modelIds,
          predictionDeadline: new Date(deadline).toISOString(),
        }),
      });
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body.error?.message ?? "Could not open the round");
      }

      router.push("/competitions");
      router.refresh();
    } catch (submissionError: unknown) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Could not open the round",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error ? (
        <p
          role="alert"
          className="rounded-[10px] border border-magenta/30 bg-magenta/[0.07] px-3.5 py-2.5 text-[0.8125rem] text-magenta"
        >
          {error}
        </p>
      ) : null}

      <div>
        <label
          htmlFor="round-name"
          className="t-label mb-2 block text-[0.5625rem] text-faint"
        >
          Round name
        </label>
        <input
          id="round-name"
          required
          minLength={3}
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="isometric donut · evening round"
          className="field"
        />
      </div>

      <div>
        <label
          htmlFor="round-brief"
          className="t-label mb-2 block text-[0.5625rem] text-faint"
        >
          Brief
        </label>
        <select
          id="round-brief"
          required
          value={briefId}
          onChange={(event) => setBriefId(event.target.value)}
          className="field"
        >
          {briefs.map((brief) => (
            <option key={brief.id} value={brief.id}>
              {brief.name}
            </option>
          ))}
        </select>
        <p className="t-mono mt-2 text-[0.625rem] text-faint">
          {briefs.find((brief) => brief.id === briefId)?.meta ?? ""}
        </p>
      </div>

      <fieldset>
        <legend className="t-label mb-2.5 block text-[0.5625rem] text-faint">
          Participating models
        </legend>
        <div className="space-y-2">
          {models.map((model) => {
            const active = modelIds.includes(model.id);
            return (
              <label
                key={model.id}
                className={`flex cursor-pointer items-center gap-3 rounded-[12px] border px-4 py-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet ${
                  active
                    ? "border-magenta bg-magenta/[0.07]"
                    : "border-[var(--control-line)] bg-white/[0.015] hover:border-white/45"
                }`}
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => toggleModel(model.id)}
                  className="sr-only"
                />
                {/* filled vs hollow box: selection never relies on colour */}
                <span
                  aria-hidden="true"
                  className={`grid size-[15px] shrink-0 place-items-center rounded-[4px] border ${
                    active ? "border-magenta" : "border-white/40"
                  }`}
                >
                  <span
                    className={`size-[7px] rounded-[2px] ${
                      active ? "bg-magenta" : "bg-transparent"
                    }`}
                  />
                </span>
                <span className="text-[0.875rem] text-ink">{model.name}</span>
                <span className="t-mono ml-auto text-[0.625rem] text-faint">
                  {model.meta}
                </span>
              </label>
            );
          })}
        </div>
        <p className="t-mono mt-2.5 text-[0.625rem] text-faint">
          {modelIds.length} of {models.length} selected · at least two
        </p>
      </fieldset>

      <div>
        <label
          htmlFor="round-deadline"
          className="t-label mb-2 block text-[0.5625rem] text-faint"
        >
          Staking closes
        </label>
        <input
          id="round-deadline"
          required
          type="datetime-local"
          value={deadline}
          onChange={(event) => setDeadline(event.target.value)}
          className="field"
        />
        <p className="t-mono mt-2 text-[0.625rem] text-faint">
          Sealed before a single frame exists.
        </p>
      </div>

      <button
        type="submit"
        disabled={submitting || !canSubmit}
        className="btn btn-solid btn-block"
      >
        {submitting ? "Opening round…" : "Open round"}
      </button>
    </form>
  );
}
