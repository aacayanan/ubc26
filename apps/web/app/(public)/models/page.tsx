"use client";

import { EmptyState, Meter, PageHeader, Panel } from "@/components/ui";

interface ModelStats {
  model_id: string;
  model_name: string;
  rounds_played: number;
  conformance_wins: number;
  crowd_wins: number;
  forfeits: number;
}

export default function ModelsPage() {
  // TODO: load from API — GET /api/models
  const models: ModelStats[] = [];

  return (
    <div className="shell py-14 sm:py-16">
      <PageHeader
        title="Models"
        description="Two separate records that are never merged: how often a model conformed to the brief, and how often the crowd named it best."
      />

      <div className="mt-10">
        {models.length === 0 ? (
          <EmptyState
            title="No settled rounds yet."
            action={
              <span className="btn btn-ghost btn-sm pointer-events-none text-muted">
                Awaiting first settle
              </span>
            }
          >
            Conformance and crowd results are recorded per model after each
            round settles. Nothing here is estimated in advance.
          </EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {models.map((m) => {
              const rate =
                m.rounds_played > 0 ? m.conformance_wins / m.rounds_played : 0;
              return (
                <li key={m.model_id}>
                  <Panel className="p-6">
                    <div className="flex items-baseline justify-between gap-3">
                      <h2 className="t-title text-[1.0625rem] text-ink">
                        {m.model_name}
                      </h2>
                      <span className="t-mono text-[0.625rem] text-faint">
                        {m.rounds_played} rounds
                      </span>
                    </div>

                    <div className="mt-5">
                      <div className="flex items-baseline justify-between">
                        <span className="t-label text-[0.5625rem] text-faint">
                          Conformance
                        </span>
                        <span className="t-num text-[0.6875rem] text-muted">
                          {Math.round(rate * 100)}%
                        </span>
                      </div>
                      <Meter
                        value={rate}
                        className="mt-2"
                        label={`${m.model_name} conformed in ${Math.round(rate * 100)} percent of ${m.rounds_played} rounds`}
                      />
                    </div>

                    <dl className="mt-5 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-hairline bg-hairline">
                      {[
                        ["Conformed", m.conformance_wins],
                        ["Crowd", m.crowd_wins],
                        ["Forfeits", m.forfeits],
                      ].map(([label, value]) => (
                        <div
                          key={String(label)}
                          className="bg-void-2/80 px-3 py-2.5"
                        >
                          <dt className="t-label text-[0.5rem] text-faint">
                            {label}
                          </dt>
                          <dd className="t-num mt-1 text-sm text-ink">
                            {value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </Panel>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
