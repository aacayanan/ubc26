import "server-only";

import type {
  ExecutionRunType,
  ExecutionStatus,
  LLMFailureKind,
} from "@ai-showdown/shared";
import { InternalError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";
import { getServiceRoleSupabase } from "@/lib/server/integrations/supabase/admin";

/**
 * Writes for the evaluation tables (F13).
 *
 * `model_executions` and `test_results` have a public SELECT policy and no
 * write policy, so the service-role client is the only way in. Every write here
 * uses `onConflict` against a composite unique key the schema already defines,
 * so an interrupted run resumes rather than duplicating.
 */

/**
 * Hard cap on captured output written to Postgres.
 *
 * `test_results.stdout`/`stderr` are unbounded `text` and publicly readable
 * (`test_results_public_read` selects every row). Without a cap, one round of
 * 50 tests × 3 models could publish megabytes of raw model output. 8 KiB keeps
 * enough to debug a failure while bounding what a round costs to store.
 */
export const STDOUT_LIMIT_BYTES = 8 * 1024;

export interface ExecutionUpsert {
  roundId: string;
  modelId: string;
  runType: ExecutionRunType;
  attempt: number;
  openrouterModelId: string;
  config: Record<string, unknown>;
  sandboxImage?: string;
  harnessProtocol?: number;
  status: ExecutionStatus;
  solutionCode?: string | null;
  // F16 diagnostics. All optional so the F13 caller is unaffected.
  attemptCount?: number;
  providerRequestId?: string | null;
  failureKind?: LLMFailureKind | null;
  responseMeta?: Record<string, unknown>;
}

export interface TestResultUpsert {
  testCaseId: string;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number | null;
}

/**
 * Truncate to a byte budget without splitting a multi-byte character.
 *
 * Slicing a JS string by UTF-16 code unit or by character count can leave a
 * lone surrogate, which Postgres rejects as invalid UTF-8. Cutting the UTF-8
 * buffer and decoding it with replacement-character stripping is safe.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (text.length === 0) return text;

  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;

  let sliced = buffer.subarray(0, maxBytes).toString("utf8");
  // A cut mid-sequence decodes to U+FFFD; drop the incomplete tail.
  if (sliced.endsWith("�")) {
    sliced = sliced.slice(0, -1);
  }
  return sliced;
}

/**
 * Create or resume the execution row for this (round, model, run_type, attempt).
 *
 * The composite unique key turns a retry into an UPDATE of the existing row,
 * which is what makes an interrupted evaluation safe to restart.
 */
export async function upsertExecution(
  row: ExecutionUpsert,
): Promise<{ id: string }> {
  const supabase = getServiceRoleSupabase();

  const { data, error } = await supabase
    .from("model_executions")
    .upsert(
      {
        round_id: row.roundId,
        model_id: row.modelId,
        run_type: row.runType,
        attempt: row.attempt,
        openrouter_model_id: row.openrouterModelId,
        config: row.config,
        status: row.status,
        solution_code: row.solutionCode ?? null,
        sandbox_image: row.sandboxImage ?? null,
        harness_protocol: row.harnessProtocol ?? null,
        attempt_count: row.attemptCount ?? 1,
        provider_request_id: row.providerRequestId ?? null,
        failure_kind: row.failureKind ?? null,
        response_meta: row.responseMeta ?? {},
      },
      { onConflict: "round_id,model_id,run_type,attempt" },
    )
    .select("id")
    .single();

  if (error) {
    throw new InternalError("Failed to record the model execution", error);
  }

  return { id: (data as { id: string }).id };
}

/**
 * Upsert one verdict per test.
 *
 * A `test_cases` row deleted between job construction and persistence trips the
 * FK (23503) and aborts the whole batch. Rather than lose every other verdict,
 * fall back to writing row by row and skip the ones that no longer reference a
 * test case.
 */
export async function upsertTestResults(
  executionId: string,
  rows: TestResultUpsert[],
): Promise<{ written: number; skipped: number }> {
  if (rows.length === 0) return { written: 0, skipped: 0 };

  const supabase = getServiceRoleSupabase();

  const toRecord = (row: TestResultUpsert) => ({
    execution_id: executionId,
    test_case_id: row.testCaseId,
    passed: row.passed,
    stdout: truncateUtf8(row.stdout, STDOUT_LIMIT_BYTES),
    stderr: truncateUtf8(row.stderr, STDOUT_LIMIT_BYTES),
    exit_code: row.exitCode,
    duration_ms: row.durationMs,
  });

  const { error } = await supabase
    .from("test_results")
    .upsert(rows.map(toRecord), {
      onConflict: "execution_id,test_case_id",
    });

  if (!error) {
    return { written: rows.length, skipped: 0 };
  }

  // 23503 = foreign_key_violation: a referenced test case is gone.
  if (!isForeignKeyViolation(error)) {
    throw new InternalError("Failed to record test results", error);
  }

  let written = 0;
  let skipped = 0;

  for (const row of rows) {
    const { error: rowError } = await supabase
      .from("test_results")
      .upsert(toRecord(row), { onConflict: "execution_id,test_case_id" });

    if (rowError) {
      if (isForeignKeyViolation(rowError)) {
        skipped += 1;
        continue;
      }
      throw new InternalError("Failed to record a test result", rowError);
    }

    written += 1;
  }

  if (skipped > 0) {
    logger.warn("sandbox.results.row_skipped", { skipped, written });
  }

  return { written, skipped };
}

export async function markExecutionStatus(
  executionId: string,
  status: ExecutionStatus,
  patch: {
    errorMessage?: string | null;
    latencyMs?: number | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    solutionCode?: string | null;
    attemptCount?: number | null;
    providerRequestId?: string | null;
    failureKind?: LLMFailureKind | null;
    responseMeta?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const supabase = getServiceRoleSupabase();

  const { error } = await supabase
    .from("model_executions")
    .update({
      status,
      ...(patch.errorMessage !== undefined
        ? { error_message: patch.errorMessage }
        : {}),
      ...(patch.latencyMs !== undefined ? { latency_ms: patch.latencyMs } : {}),
      ...(patch.startedAt !== undefined ? { started_at: patch.startedAt } : {}),
      ...(patch.finishedAt !== undefined
        ? { finished_at: patch.finishedAt }
        : {}),
      ...(patch.solutionCode !== undefined
        ? { solution_code: patch.solutionCode }
        : {}),
      ...(patch.attemptCount !== undefined && patch.attemptCount !== null
        ? { attempt_count: patch.attemptCount }
        : {}),
      ...(patch.providerRequestId !== undefined
        ? { provider_request_id: patch.providerRequestId }
        : {}),
      ...(patch.failureKind !== undefined
        ? { failure_kind: patch.failureKind }
        : {}),
      ...(patch.responseMeta !== undefined
        ? { response_meta: patch.responseMeta }
        : {}),
    })
    .eq("id", executionId);

  if (error) {
    throw new InternalError("Failed to update the execution status", error);
  }
}

function isForeignKeyViolation(error: { code?: string }): boolean {
  // 23503 = foreign_key_violation.
  return error.code === "23503";
}
