import "server-only";

import {
  SANDBOX_PROTOCOL_VERSION,
  type ExecutionRunType,
  type ExecutionStatus,
  type SandboxTestRecord,
} from "@ai-showdown/shared";
import { runBackgroundTask } from "@/lib/server/background/task";
import { logger } from "@/lib/server/logging/logger";
import { getSandboxEnv } from "@/lib/config/sandbox";
import {
  runSandboxContainer,
  type SandboxContainerResult,
} from "@/lib/server/integrations/docker/sandbox";
import {
  buildSandboxJob,
  parseExpectedOutput,
  parseResultStream,
  type EvaluationTestCase,
} from "@/lib/server/services/evaluation/contract";
import { jsonDeepEqual } from "@/lib/server/services/evaluation/compare";
import {
  markExecutionStatus,
  upsertExecution,
  upsertTestResults,
  type TestResultUpsert,
} from "@/lib/server/services/evaluation/persist";

/**
 * Run one model's solution in the sandbox and record the verdicts (F13).
 *
 * This is the `runBackgroundTask` boundary. It owns the sandbox run, the
 * host-side comparison, and the writes to `model_executions` / `test_results`.
 * It does NOT drive round lifecycle — `RUNNING → EVALUATING` belongs to F7/F17.
 *
 * Status rule that is easy to invert: a solution that fails tests is still
 * `succeeded`. `succeeded` means the sandbox ran to completion; correctness
 * lives in `test_results`. `timeout`/`error` are reserved for runs that did not
 * complete under known conditions, and `unavailable` is infrastructure (no
 * daemon, missing image) — never the model's fault.
 */

export interface RunModelSolutionInput {
  roundId: string;
  modelId: string;
  runType: ExecutionRunType;
  attempt: number;
  openrouterModelId: string;
  config: Record<string, unknown>;
  /** The generated source. Never logged — the logger redacts such keys anyway. */
  source: string;
  entryPoint: string;
  testCases: EvaluationTestCase[];
  correlationId: string;
}

export interface RunModelSolutionResult {
  executionId: string;
  status: ExecutionStatus;
  testsPassed: number;
  testsTotal: number;
}

export async function runModelSolution(
  input: RunModelSolutionInput,
): Promise<RunModelSolutionResult> {
  const { correlationId, roundId, modelId, runType, attempt } = input;

  return runBackgroundTask(
    {
      task: "evaluation.sandbox.run",
      correlationId,
      context: { roundId, modelId, runType, attempt },
    },
    async () => {
      const env = getSandboxEnv();
      const job = buildSandboxJob({
        source: input.source,
        entryPoint: input.entryPoint,
        runType,
        testCases: input.testCases,
        correlationId,
      });

      const { id: executionId } = await upsertExecution({
        roundId,
        modelId,
        runType,
        attempt,
        openrouterModelId: input.openrouterModelId,
        config: input.config,
        sandboxImage: env.imageRef,
        harnessProtocol: SANDBOX_PROTOCOL_VERSION,
        status: "running",
        solutionCode: input.source,
      });

      await markExecutionStatus(executionId, "running", {
        startedAt: new Date().toISOString(),
      });

      const container = await runSandboxContainer({
        // Derived from ids the server controls, never from user input, so the
        // timeout path can find the container and the orphan sweep is safe.
        containerName: `f13-${executionId}-${attempt}`,
        jobJson: JSON.stringify(job),
        wallClockMs: env.wallClockMs,
      });

      const outcome = await recordOutcome({
        executionId,
        container,
        testCases: input.testCases,
        correlationId,
      });

      return { executionId, ...outcome };
    },
  );
}

/**
 * Turn the container's output into a status and per-test rows.
 *
 * Kept separate from the abort/cleanup paths so the mapping is in one place.
 */
async function recordOutcome(params: {
  executionId: string;
  container: SandboxContainerResult;
  testCases: EvaluationTestCase[];
  correlationId: string;
}): Promise<{
  status: ExecutionStatus;
  testsPassed: number;
  testsTotal: number;
}> {
  const { executionId, container, testCases, correlationId } = params;

  const byOrdinal = new Map(testCases.map((test) => [test.ordinal, test]));
  const parsed = parseResultStream(container.stdout);

  if (parsed.rejectedLines > 0) {
    // Bare count only: the rejected lines may contain model output.
    logger.warn("sandbox.result.lines_rejected", {
      correlationId,
      rejectedLines: parsed.rejectedLines,
    });
  }

  const rows: TestResultUpsert[] = [];
  let passed = 0;

  for (const record of parsed.records) {
    const testCase = byOrdinal.get(record.ordinal);
    if (!testCase) {
      // A record for an ordinal the host never sent — ignore, do not persist.
      logger.warn("sandbox.result.unknown_ordinal", {
        correlationId,
        ordinal: record.ordinal,
      });
      continue;
    }

    const verdict = judgeTest(record, testCase, correlationId);
    if (verdict.passed) passed += 1;

    rows.push({
      testCaseId: testCase.id,
      passed: verdict.passed,
      stdout: record.stdout,
      stderr: record.stderr,
      exitCode: record.exitCode,
      durationMs: Math.round(record.durationMs),
    });
  }

  const status = classifyExecution(container, parsed.records, testCases.length);

  if (status === "unavailable") {
    // Infrastructure failure: no container-side result to write.
    await markExecutionStatus(executionId, "unavailable", {
      errorMessage: "Sandbox unavailable",
      finishedAt: new Date().toISOString(),
    });
    return { status, testsPassed: 0, testsTotal: testCases.length };
  }

  await upsertTestResults(executionId, rows);
  await markExecutionStatus(executionId, status, {
    latencyMs: container.wallMs,
    finishedAt: new Date().toISOString(),
    ...(status === "succeeded"
      ? {}
      : {
          errorMessage:
            status === "timeout"
              ? "Execution exceeded the wall-clock limit"
              : container.oomKilled
                ? "Container exceeded its memory limit"
                : "Execution did not complete",
        }),
  });

  return { status, testsPassed: passed, testsTotal: testCases.length };
}

function judgeTest(
  record: SandboxTestRecord,
  testCase: EvaluationTestCase,
  correlationId: string,
): { passed: boolean } {
  // Anything other than a clean return is a failure for this test.
  if (record.outcome !== "returned") return { passed: false };

  const expected = parseExpectedOutput(
    testCase.expectedOutput,
    testCase.ordinal,
    correlationId,
  );
  const result = jsonDeepEqual(record.value, expected);

  if (!result.equal) {
    logger.info("sandbox.verdict.mismatch", {
      correlationId,
      ordinal: testCase.ordinal,
      // Safe: compare.ts truncates and the value is the model's own answer.
      reason: result.reason,
    });
  }

  return { passed: result.equal };
}

/**
 * Decide the execution-level status from the run as a whole.
 *
 * Order matters: infrastructure first, then whether the harness ever ran, then
 * whether the run was cut short.
 */
function classifyExecution(
  container: SandboxContainerResult,
  records: SandboxTestRecord[],
  totalTests: number,
): ExecutionStatus {
  if (container.unavailable) {
    // Docker itself never produced a result: daemon down, image missing, binary
    // absent. Infrastructure, not the model — F16/F15 apply a retry/forfeit
    // policy to this, not a correctness verdict.
    return "unavailable";
  }

  if (container.exitCode === null) {
    return "unavailable";
  }

  if (container.oomKilled) return "error";
  if (container.timedOut) return "timeout";

  // Every test timing out means the run never made progress; a single timeout
  // is just that test failing.
  const allTimedOut =
    totalTests > 0 &&
    records.length > 0 &&
    records.every((record) => record.outcome === "timeout");
  if (allTimedOut) return "timeout";

  // Fewer records than tests means the harness stopped early (budget exhausted
  // or it died mid-run) — the run did not complete.
  if (records.length < totalTests) return "error";

  // A solution that fails every test has still run to completion.
  return "succeeded";
}
