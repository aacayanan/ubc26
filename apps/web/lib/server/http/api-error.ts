import "server-only";

import { AppError, normalizeError } from "@/lib/server/errors/app-error";
import { logger } from "@/lib/server/logging/logger";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: Record<string, unknown>;
  };
}

export function getCorrelationId(request?: Request): string {
  if (request) {
    const headerValue = request.headers.get("x-correlation-id");
    if (headerValue?.trim()) {
      return headerValue.trim().slice(0, 128);
    }
  }

  return crypto.randomUUID();
}

export function toApiErrorResponse(
  error: unknown,
  options: { correlationId: string; method?: string; path?: string },
): Response {
  const appError = normalizeError(error);
  const { correlationId, method, path } = options;
  const details = appError.details;

  if (appError.status >= 500) {
    const cause = appError.cause instanceof Error ? appError.cause : undefined;

    logger.error("api.request.failed", {
      correlationId,
      method,
      path,
      errorCode: appError.code,
      errorName: appError.name,
      causeName: cause?.name,
      causeType: cause ? "Error" : typeof appError.cause,
    });
  } else {
    logger.warn("api.request.rejected", {
      correlationId,
      method,
      path,
      errorCode: appError.code,
    });
  }

  const body: ApiErrorBody = {
    error: {
      code: appError.code,
      message: appError.expose
        ? appError.message
        : "An unexpected error occurred",
      correlationId,
      ...(details ? { details } : {}),
    },
  };

  return Response.json(body, {
    status: appError.status,
    headers: {
      "x-correlation-id": correlationId,
    },
  });
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export async function withApiErrorHandling(
  request: Request,
  operation: (correlationId: string) => Promise<Response>,
): Promise<Response> {
  const correlationId = getCorrelationId(request);

  try {
    return await operation(correlationId);
  } catch (error) {
    const url = new URL(request.url);
    return toApiErrorResponse(error, {
      correlationId,
      method: request.method,
      path: url.pathname,
    });
  }
}
