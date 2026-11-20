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

/* ------------------------------------------------------------------ *
 * Draft pricing — "if you send this now"
 * ------------------------------------------------------------------ */

/** Probability in percent, shown on the board, that a model conforms. */
export interface ModelPrice {
  modelId: string;
  modelName: string;
  /** Points already riding on the model (including the viewer's own). */
  staked: number;
  /** Implied chance this model conforms, 0..100. */
  percent: number;
  /** Points returned per point staked if it wins; null when unbacked. */
  multiplier: number | null;
}

/** The board as it would read the moment a draft stake lands. */
export interface DraftPricing {
  /** The pool after the draft stake is included (the viewer's old stake is replaced, not added). */
  pot: number;
  /** What the draft stake costs; 0 when there is nothing to price. */
  points: number;
  /** The picked model, or null while nothing is picked. */
  pickedModelId: string | null;
  models: ModelPrice[];
  /**
   * Change in the picked model's implied chance, in percentage points, against
   * the pool as it stands. Positive: your own stake is money on that side, so
   * the market now prices it more likely. The multiplier moves the other way —
   * the same pot split across more backers pays each of them less — which is why
   * both are shown together rather than either one alone.
   */
  pickedDeltaPoints: number;
  /** The picked model's price after the draft, or null when nothing is picked. */
  pickedPercent: number | null;
  /**
   * Change in the picked model's multiplier, against the pool as it stands.
   * Never positive: buying into a side always shares the payout thinner.
   */
  pickedDeltaMultiplier: number | null;
}

/**
 * Price the pool as if `points` were staked on `pickedModelId` right now.
 *
 * Parimutuel pricing is the pot over the money on a side, so the honest
 * probability of a model is `stakedOn(model) / pot` — the share of the pot that
 * expects to be paid on it. It is a market-implied number, not a forecast, and
 * it moves only when somebody stakes: a render cannot exist while staking is
 * open, so nothing else can pull a price around.
 *
 * The draft stake **replaces** the viewer's own holding on that model rather
 * than adding to it: `place_stake` is an upsert (one conformance stake per
 * account per round), so pricing it as an add would quietly overstate both the
 * pot and the price after sending. `ownStaked` is therefore moved out of the
 * model it currently sits on and into the draft.
 *
 * With an empty pool every price is 0 and stays 0: there is no market yet, and
 * inventing a flat 33/33/33 would be a claim nobody made. A single stake into an
 * empty pool prices its model at 100 — which is arithmetically true (it is the
 * whole pot) and reads correctly as "nobody has disagreed yet".
 */
export function computeDraftPricing(input: {
  models: ReadonlyArray<{ id: string; name: string }>;
  stakesByModel: Readonly<Record<string, number>>;
  /** The viewer's existing stake, if they have one, so it is replaced. */
  ownStake?: { modelId: string; points: number } | null;
  pickedModelId: string | null;
  points: number;
}): DraftPricing {
  const { models, stakesByModel, ownStake, pickedModelId } = input;

  const draftPoints =
    pickedModelId !== null && Number.isFinite(input.points)
      ? Math.max(0, Math.floor(input.points))
      : 0;

  // The pool without the viewer's own stake: their stake is going to be
  // re-placed (possibly on another model, possibly at another size), so it is
  // not part of the background every other model is priced against.
  const background: Record<string, number> = {};
  for (const [modelId, value] of Object.entries(stakesByModel)) {
    if (Number.isFinite(value) && value > 0) background[modelId] = value;
  }
  if (ownStake && background[ownStake.modelId] !== undefined) {
    const remaining = background[ownStake.modelId] - ownStake.points;
    if (remaining > 0) background[ownStake.modelId] = remaining;
    else delete background[ownStake.modelId];
  }

  const priced = models.map((model) => {
    const staked =
      Math.max(0, Math.floor(background[model.id] ?? 0)) +
      (model.id === pickedModelId ? draftPoints : 0);
    return { model, staked };
  });

  // Every stake in the pool counts, including one on a model that is no longer
  // listed; the visible models are priced against the same total.
  let pot = 0;
  for (const value of Object.values(background)) pot += value;
  pot += draftPoints;

  const pricedModels: ModelPrice[] = priced.map(({ model, staked }) => ({
    modelId: model.id,
    modelName: model.name,
    staked,
    percent: percentOf(staked, pot),
    multiplier: staked > 0 && pot > 0 ? round2(pot / staked) : null,
  }));

  const picked = pricedModels.find(
    (model) => model.modelId === pickedModelId,
  );
  // The picked model's price without the draft, for the delta. `ownStake` is
  // the only thing the draft changes on the viewer's side, so the baseline is
  // the pool exactly as it stands (their own stake included).
  const standing = computePoolOdds({ models, stakesByModel });
  const standingPicked = standing.models.find(
    (model) => model.modelId === pickedModelId,
  );

  const pickedDeltaMultiplier =
    picked &&
    standingPicked &&
    picked.multiplier !== null &&
    standingPicked.multiplier !== null
      ? round2(picked.multiplier - standingPicked.multiplier)
      : null;

  return {
    pot,
    points: draftPoints,
    pickedModelId,
    models: pricedModels,
    pickedDeltaPoints:
      picked && standingPicked
        ? round2(picked.percent - percentOf(standingPicked.staked, standing.pot))
        : 0,
    pickedPercent: picked ? picked.percent : null,
    pickedDeltaMultiplier,
  };
}

/**
 * Share of the pot, as a percentage. A model's implied chance of conforming is
 * its share of the money: backers put points where they think the answer is.
 * A zero pot has no shares — everything reads 0, never NaN.
 */
function percentOf(staked: number, pot: number): number {
  if (pot <= 0 || staked <= 0) return 0;
  return round2((staked / pot) * 100);
}
