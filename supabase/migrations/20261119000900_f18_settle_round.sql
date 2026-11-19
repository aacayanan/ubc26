-- F18, part 2: settle a round exactly once, in one transaction.
--
-- Everything settlement must keep true at once lives here rather than in
-- separate app-side calls, because an interrupted settlement that wrote half its
-- effects would double-pay or strand points on retry:
--
--   every conformance stake settled  →  one score event per user per kind  →
--   balances credited  →  competition_results + round_outcomes written  →
--   round moved to SETTLED/VOIDED
--
-- The last step is the reason the order is not negotiable: the F15 trigger
-- `ensure_round_stakes_settled` refuses the terminal transition while any
-- conformance stake is still open, so a caller that forgets to settle first fails
-- loudly instead of stranding points.
--
-- Idempotency is the first check, not the last: a round already SETTLED/VOIDED
-- returns `alreadySettled: true` before writing anything, so a retried job (or
-- two overlapping ones) cannot pay twice. The inner row latch
-- (`settled_at is null`) and the `score_events` unique key are the backstops.
--
-- The app computes the money-free math (`computeParimutuelPayouts`,
-- `computeFanFavoriteAwards`) and passes the result in; this function does not
-- decide who won. Keeping the pot arithmetic in one pure, tested TS module is
-- deliberate — this layer only validates it against the stored stakes and writes.

-- The pot and payout reads are per round; make them a range read.
create index if not exists score_events_round_idx
  on public.score_events (round_id);

-- F15 guarded score_events against UPDATE/DELETE after the round finalizes, but
-- not against INSERT. An insert into a settled round would add an orphan ledger
-- row that the leaderboard sums — points minted after the outcome was fixed. F18
-- is the first writer of this table, so close it here: a score event may only be
-- written while the round is still being decided.
create or replace function public.prevent_finalized_score_insert()
returns trigger
language plpgsql
as $$
declare
  v_status public.round_status;
begin
  select status into v_status
    from public.rounds
    where id = new.round_id;

  if v_status in ('SETTLED', 'VOIDED', 'ARCHIVED') then
    raise exception 'results for finalized round % cannot be modified', new.round_id;
  end if;

  return new;
end;
$$;

drop trigger if exists score_events_prevent_finalized_insert on public.score_events;
create trigger score_events_prevent_finalized_insert
  before insert on public.score_events
  for each row execute function public.prevent_finalized_score_insert();

create or replace function public.settle_round(
  p_round_id uuid,
  p_kind text,
  p_winner_model_id uuid,
  p_fan_favorite_model_id uuid,
  p_tie_break text,
  p_reason text,
  p_all_forfeited boolean,
  p_results jsonb,
  p_stakes jsonb,
  p_awards jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.round_status;
  v_existing_kind text;
  v_now timestamptz := now();
  v_open_count integer;
  v_supplied_count integer;
  v_credited integer := 0;
  v_stakes_settled integer := 0;
  v_stake jsonb;
  v_award jsonb;
  v_award_points integer;
  v_rows integer;
begin
  if p_kind is null or p_kind not in ('settled', 'voided') then
    raise exception 'settlement kind must be settled or voided' using errcode = '22023';
  end if;

  if p_kind = 'settled'
     and (p_winner_model_id is null or p_tie_break is null) then
    raise exception 'a settled round needs a winner and a tiebreak'
      using errcode = '22023';
  end if;

  if p_kind = 'voided'
     and (p_winner_model_id is not null or p_tie_break is not null) then
    raise exception 'a voided round names no winner and no tiebreak'
      using errcode = '22023';
  end if;

  -- Lock the round first so two settlements serialize on it.
  select status into v_status
    from public.rounds
    where id = p_round_id
    for update;

  if v_status is null then
    raise exception 'round % does not exist', p_round_id using errcode = 'P0002';
  end if;

  -- Idempotency latch: a final round is a no-op that reports what was recorded.
  if v_status in ('SETTLED', 'VOIDED', 'ARCHIVED') then
    select kind into v_existing_kind
      from public.round_outcomes
      where round_id = p_round_id;

    return jsonb_build_object(
      'alreadySettled', true,
      'kind', coalesce(v_existing_kind, lower(v_status::text)),
      'stakesSettled', 0,
      'pointsCredited', 0
    );
  end if;

  if v_status <> 'EVALUATING' then
    raise exception 'round % is % and cannot be settled', p_round_id, v_status
      using errcode = 'P0001';
  end if;

  -- Completeness: the caller must hand over every open conformance stake, and
  -- no row that is not one. Catching a mismatch here is what stops a partial
  -- payout from finalizing the round.
  select count(*) into v_open_count
    from public.predictions
    where round_id = p_round_id
      and category = 'conformance'
      and settled_at is null;

  v_supplied_count := coalesce(jsonb_array_length(p_stakes), 0);

  if v_open_count <> v_supplied_count then
    raise exception 'round % has % open stake(s) but % were supplied to settle',
      p_round_id, v_open_count, v_supplied_count using errcode = 'P0001';
  end if;

  -- Settle each stake. The update is filtered on `settled_at is null` and joins
  -- back to the round + category, so a stale or invented prediction_id touches
  -- nothing rather than editing the wrong row. Every supplied stake must match a
  -- real open row; otherwise the set is inconsistent and we abort.
  for v_stake in select * from jsonb_array_elements(coalesce(p_stakes, '[]'::jsonb))
  loop
    if v_stake->>'outcome' not in ('won', 'lost', 'void') then
      raise exception 'stake % has an invalid outcome %',
        v_stake->>'prediction_id', v_stake->>'outcome' using errcode = '22023';
    end if;

    update public.predictions
      set settled_at = v_now,
          settlement_outcome = v_stake->>'outcome',
          points_awarded = coalesce((v_stake->>'points_awarded')::integer, 0)
      where id = (v_stake->>'prediction_id')::uuid
        and round_id = p_round_id
        and category = 'conformance'
        and settled_at is null;

    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'stake % is not an open conformance stake of round %',
        v_stake->>'prediction_id', p_round_id using errcode = 'P0001';
    end if;

    v_stakes_settled := v_stakes_settled + 1;

    -- One ledger row per user per kind, including the zero-point losers, so
    -- "Rounds" on the leaderboard counts every settled stake. `do nothing` keeps
    -- a retried settlement from stacking a second event.
    insert into public.score_events (round_id, user_id, kind, points)
    values (
      p_round_id,
      (v_stake->>'user_id')::uuid,
      'stake',
      coalesce((v_stake->>'points_awarded')::integer, 0)
    )
    on conflict (round_id, user_id, kind) do nothing;

    v_credited := v_credited + coalesce((v_stake->>'points_awarded')::integer, 0);
  end loop;

  -- Fan-favorite awards: a separate, smaller credit, one per voter of the crowd's
  -- winner. Not part of the pool.
  for v_award in select * from jsonb_array_elements(coalesce(p_awards, '[]'::jsonb))
  loop
    v_award_points := coalesce((v_award->>'points')::integer, 0);
    if v_award_points <= 0 then
      raise exception 'A fan-favorite award must be positive' using errcode = '22023';
    end if;

    insert into public.score_events (round_id, user_id, kind, points)
    values (
      p_round_id,
      (v_award->>'user_id')::uuid,
      'fan_favorite',
      v_award_points
    )
    on conflict (round_id, user_id, kind) do nothing;

    v_credited := v_credited + v_award_points;
  end loop;

  -- Credit balances, one row per affected user, with the streak rule (F18):
  -- won -> +1, lost -> 0, void -> unchanged; longest tracks the maximum.
  -- Summed per user so a user who both won and won the fan-favorite is credited
  -- once in one update.
  with credits as (
    select user_id, sum(points)::integer as points
      from public.score_events
      where round_id = p_round_id
      group by user_id
  ),
  stake_outcome as (
    select user_id, settlement_outcome
      from public.predictions
      where round_id = p_round_id
        and category = 'conformance'
  )
  insert into public.user_scores as us (
    user_id, total_points, current_streak, longest_streak, last_scored_round_id
  )
  select
    c.user_id,
    c.points,
    case
      when so.settlement_outcome = 'won' then 1
      else 0
    end,
    case
      when so.settlement_outcome = 'won' then 1
      else 0
    end,
    p_round_id
  from credits c
  left join stake_outcome so on so.user_id = c.user_id
  on conflict (user_id) do update
    set total_points = us.total_points + excluded.total_points,
        current_streak = case
          when exists (
            select 1 from public.predictions p
            where p.round_id = p_round_id
              and p.user_id = us.user_id
              and p.settlement_outcome = 'won'
          ) then us.current_streak + 1
          when exists (
            select 1 from public.predictions p
            where p.round_id = p_round_id
              and p.user_id = us.user_id
              and p.settlement_outcome = 'lost'
          ) then 0
          -- Void, or a fan-favorite-only credit: the streak is unchanged.
          else us.current_streak
        end,
        longest_streak = greatest(
          us.longest_streak,
          case
            when exists (
              select 1 from public.predictions p
              where p.round_id = p_round_id
                and p.user_id = us.user_id
                and p.settlement_outcome = 'won'
            ) then us.current_streak + 1
            when exists (
              select 1 from public.predictions p
              where p.round_id = p_round_id
                and p.user_id = us.user_id
                and p.settlement_outcome = 'lost'
            ) then 0
            else us.current_streak
          end
        ),
        last_scored_round_id = p_round_id;

  -- Model results: one row per model, upserted on the F2 unique key.
  insert into public.competition_results (
    round_id, model_id, category, status, placement, metric_value, reason
  )
  select
    p_round_id,
    (r->>'model_id')::uuid,
    'conformance',
    (r->>'status')::public.result_status,
    null,
    null,
    r->>'reason'
  from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) r
  on conflict (round_id, model_id, category) do update
    set status = excluded.status,
        reason = excluded.reason;

  -- The one outcome row, shaped by the F15 constraint.
  insert into public.round_outcomes (
    round_id, kind, winner_model_id, fan_favorite_model_id, tie_break, reason,
    all_forfeited
  ) values (
    p_round_id, p_kind, p_winner_model_id, p_fan_favorite_model_id, p_tie_break,
    p_reason, coalesce(p_all_forfeited, false)
  )
  on conflict (round_id) do update
    set kind = excluded.kind,
        winner_model_id = excluded.winner_model_id,
        fan_favorite_model_id = excluded.fan_favorite_model_id,
        tie_break = excluded.tie_break,
        reason = excluded.reason,
        all_forfeited = excluded.all_forfeited;

  -- Finalize last: the F15 trigger refuses this while any stake is open, which
  -- can only happen if the loop above missed one — the guard, not the hope.
  perform public.transition_round(
    p_round_id,
    case when p_kind = 'settled'
         then 'SETTLED'::public.round_status
         else 'VOIDED'::public.round_status
    end,
    'EVALUATING'::public.round_status,
    p_reason,
    null
  );

  return jsonb_build_object(
    'alreadySettled', false,
    'kind', p_kind,
    'stakesSettled', v_stakes_settled,
    'pointsCredited', v_credited
  );
end;
$$;

revoke all on function public.settle_round(
  uuid, text, uuid, uuid, text, text, boolean, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.settle_round(
  uuid, text, uuid, uuid, text, text, boolean, jsonb, jsonb, jsonb
) to service_role;

comment on function public.settle_round(
  uuid, text, uuid, uuid, text, text, boolean, jsonb, jsonb, jsonb
) is
  'F18: resolve a round exactly once — settle every stake, write the ledger and the outcome, credit balances, then move the round to SETTLED/VOIDED in one transaction. Idempotent: a final round returns alreadySettled without writing.';
