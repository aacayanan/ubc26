import "server-only";

import { normalizeError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";

export interface BackgroundTaskOptions {
  task: string;
  correlationId: string;
  context?: Record<string, unknown>;
}

export async function runBackgroundTask<T>(
  options: BackgroundTaskOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const { task, correlationId, context } = options;

  logger.info("background.task.started", {
    ...context,
    correlationId,
    task,
  });

  try {
    const result = await operation();
    logger.info("background.task.completed", {
      ...context,
      correlationId,
      task,
    });
    return result;
  } catch (error) {
    const appError = normalizeError(error);
    logger.error("background.task.failed", {
      ...context,
      correlationId,
      task,
      errorCode: appError.code,
      errorName: appError.name,
      causeType: appError.cause instanceof Error ? "Error" : undefined,
      causeName:
        appError.cause instanceof Error ? appError.cause.name : undefined,
    });
    throw appError;
  }
}
