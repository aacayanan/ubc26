import "server-only";

/**
 * Value comparison for sandbox verdicts (F13).
 *
 * The container never decides whether a test passed — it only reports the
 * solution's return value. This module is where the host turns that value into
 * a verdict, which is why a forged result record can only ever substitute the
 * solution's own answer.
 *
 * Deliberately not `JSON.stringify(a) === JSON.stringify(b)`: that compares key
 * order and renders `1.0` and `1` differently, so it rejects correct answers.
 */

export interface CompareOptions {
  /** Absolute tolerance, applied when either side is a float. */
  absTol?: number;
  /** Relative tolerance, scaled by the larger magnitude. */
  relTol?: number;
}

export interface CompareResult {
  equal: boolean;
  /** Short, log-safe explanation when `equal` is false. */
  reason?: string;
}

const DEFAULT_ABS_TOL = 1e-9;
const DEFAULT_REL_TOL = 1e-9;
const REASON_VALUE_LIMIT = 80;

function describe(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? JSON.stringify(value) : String(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  return text.length > REASON_VALUE_LIMIT
    ? `${text.slice(0, REASON_VALUE_LIMIT)}…`
    : text;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function compareNumbers(
  actual: number,
  expected: number,
  absTol: number,
  relTol: number,
): boolean {
  // NaN is only equal to NaN; a finite number is never equal to NaN.
  if (Number.isNaN(actual) || Number.isNaN(expected)) {
    return Number.isNaN(actual) && Number.isNaN(expected);
  }

  // Guard before arithmetic: Infinity - Infinity is NaN, which would slip
  // through a naive tolerance check, and -0 must compare equal to 0.
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
    return actual === expected;
  }

  if (actual === expected) return true;

  const isFloat =
    !Number.isInteger(actual) ||
    !Number.isInteger(expected) ||
    !Number.isSafeInteger(actual);

  // Integer answers must match exactly; float answers get a tolerance so that
  // 0.30000000000000004 and 0.3 do not decide a round.
  if (!isFloat) return false;

  const tolerance = Math.max(
    absTol,
    relTol * Math.max(Math.abs(actual), Math.abs(expected)),
  );

  return Math.abs(actual - expected) <= tolerance;
}

function compareValues(
  actual: unknown,
  expected: unknown,
  absTol: number,
  relTol: number,
): CompareResult {
  if (expected === null || expected === undefined) {
    return actual === expected
      ? { equal: true }
      : { equal: false, reason: `expected null, got ${describe(actual)}` };
  }

  if (typeof expected === "number") {
    if (typeof actual !== "number") {
      return {
        equal: false,
        reason: `expected number, got ${typeName(actual)}`,
      };
    }
    return compareNumbers(actual, expected, absTol, relTol)
      ? { equal: true }
      : {
          equal: false,
          reason: `expected ${describe(expected)}, got ${describe(actual)}`,
        };
  }

  if (typeof expected === "boolean" || typeof expected === "string") {
    return actual === expected
      ? { equal: true }
      : {
          equal: false,
          reason: `expected ${describe(expected)}, got ${describe(actual)}`,
        };
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return {
        equal: false,
        reason: `expected array, got ${typeName(actual)}`,
      };
    }
    if (actual.length !== expected.length) {
      return {
        equal: false,
        reason: `array length ${actual.length} vs ${expected.length}`,
      };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const result = compareValues(
        actual[index],
        expected[index],
        absTol,
        relTol,
      );
      if (!result.equal) {
        return {
          equal: false,
          reason: `at index ${index}: ${result.reason ?? "mismatch"}`,
        };
      }
    }
    return { equal: true };
  }

  if (typeof expected === "object") {
    if (
      actual === null ||
      typeof actual !== "object" ||
      Array.isArray(actual)
    ) {
      return {
        equal: false,
        reason: `expected object, got ${typeName(actual)}`,
      };
    }

    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord);

    for (const key of expectedKeys) {
      if (!Object.prototype.hasOwnProperty.call(actualRecord, key)) {
        return { equal: false, reason: `missing key: ${key}` };
      }
    }

    const actualKeys = Object.keys(actualRecord);
    for (const key of actualKeys) {
      if (!Object.prototype.hasOwnProperty.call(expectedRecord, key)) {
        return { equal: false, reason: `unexpected key: ${key}` };
      }
    }

    for (const key of expectedKeys) {
      const result = compareValues(
        actualRecord[key],
        expectedRecord[key],
        absTol,
        relTol,
      );
      if (!result.equal) {
        return {
          equal: false,
          reason: `at key "${key}": ${result.reason ?? "mismatch"}`,
        };
      }
    }

    return { equal: true };
  }

  return {
    equal: false,
    reason: `unsupported expected type: ${typeof expected}`,
  };
}

export function jsonDeepEqual(
  actual: unknown,
  expected: unknown,
  options: CompareOptions = {},
): CompareResult {
  return compareValues(
    actual,
    expected,
    options.absTol ?? DEFAULT_ABS_TOL,
    options.relTol ?? DEFAULT_REL_TOL,
  );
}
