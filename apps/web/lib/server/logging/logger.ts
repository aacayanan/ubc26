import "server-only";

type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  correlationId?: string;
  [key: string]: unknown;
}

const PRIVATE_KEY_PATTERN =
  /(authorization|cookie|password|secret|token|api[-_]?key|generated[_-]?code|solution|source[_-]?code|prompt|stdout|stderr|test[_-]?output)/i;

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => redact(item, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) =>
        PRIVATE_KEY_PATTERN.test(key)
          ? [key, "[REDACTED]"]
          : [key, redact(item, seen)],
      ),
    );
  }

  return value;
}

function writeLog(
  level: LogLevel,
  event: string,
  context: LogContext = {},
): void {
  const redactedContext = redact(context);
  const entry = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...(typeof redactedContext === "object" &&
    redactedContext !== null &&
    !Array.isArray(redactedContext)
      ? (redactedContext as Record<string, unknown>)
      : {}),
  };

  const output = JSON.stringify(entry);

  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  debug: (event: string, context?: LogContext) =>
    writeLog("debug", event, context),
  info: (event: string, context?: LogContext) =>
    writeLog("info", event, context),
  warn: (event: string, context?: LogContext) =>
    writeLog("warn", event, context),
  error: (event: string, context?: LogContext) =>
    writeLog("error", event, context),
};
