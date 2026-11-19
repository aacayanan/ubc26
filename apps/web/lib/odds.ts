/**
 * Live pool odds (F9) — pure parimutuel math for display.
 *
 * Points are staked on "which model conforms", and the pot is split pro-rata
 * among the backers of the winner. So the number a backer cares about is the
 * *multiplier*: stake one point on a model and, if that model wins, how many
 * points come back (own stake included).
 *
 *     multiplier(model) = pot / stakedOn(model)
 *
 * That is the honest reading of the pool and it is all that can be shown. Odds
 * are quoted only from stakes, never from renders — a render cannot exist while
 * staking is open, so no model can look like it is "pulling ahead" during the
 * window. Movement in these numbers is other people's stakes and nothing else.
 *
 * A model nobody has backed has no meaningful multiplier (the pool would divide
 * by zero); it is reported as `null` rather than `Infinity`, and the UI says
 * "no backers" instead of showing a fake number.
 */

export interface ModelOdds {
  modelId: string;
  modelName: string;
  /** Points staked on this model so far. */
  staked: number;
  /**
   * Points returned per point staked if this model wins; `null` when nobody has
   * backed it (and therefore nothing could be paid).
   */
  multiplier: number | null;
  /** Share of the pot riding on this model, 0..1. */
  share: number;
}

/** Odds for one round, in a stable model order. */
export interface PoolOdds {
  pot: number;
  models: ModelOdds[];
}

/**
 * Compute per-model odds for a round.
 *
 * `stakesByModel` is the settled-in-window total per model id (see
 * `getRoundStakeSummary`); models with no entry are treated as unbacked. The
 * `models` argument fixes both the order and the set shown, so a model that is
 * competing but unbacked still appears.
 */
export function computePoolOdds(input: {
  models: ReadonlyArray<{ id: string; name: string }>;
  stakesByModel: Readonly<Record<string, number>>;
}): PoolOdds {
  const { models, stakesByModel } = input;

  // Every stake in the pool counts toward the pot, including one placed on a
  // model that is no longer listed — dropping it would overstate every
  // multiplier on screen.
  let pot = 0;
  for (const value of Object.values(stakesByModel)) {
    if (Number.isFinite(value) && value > 0) pot += value;
  }

  return {
    pot,
    models: models.map((model) => {
      const staked = Math.max(0, Math.floor(stakesByModel[model.id] ?? 0));
      return {
        modelId: model.id,
        modelName: model.name,
        staked,
        // Whole-point multipliers keep the readout steady; a pot of 0 stays
        // null because there is nothing to win yet.
        multiplier: staked > 0 && pot > 0 ? round2(pot / staked) : null,
        share: pot > 0 ? staked / pot : 0,
      };
    }),
  };
}

/** `3.25×`, or an em-free "—" when unbacked. Presentation lives in the UI. */
export function formatMultiplier(multiplier: number | null): string {
  if (multiplier === null || !Number.isFinite(multiplier)) return "—";
  return `${round2(multiplier)}×`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
