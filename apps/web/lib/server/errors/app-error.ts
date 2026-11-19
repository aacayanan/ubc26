import "server-only";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_ERROR"
  | "AUTHORIZATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

export interface AppErrorOptions {
  code: ErrorCode;
  status: number;
  message: string;
  cause?: unknown;
  details?: Record<string, unknown>;
  expose?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;

  constructor({
    code,
    status,
    message,
    cause,
    details,
    expose = true,
  }: AppErrorOptions) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.expose = expose;
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid request", details?: Record<string, unknown>) {
    super({
      code: "VALIDATION_ERROR",
      status: 400,
      message,
      details,
    });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required") {
    super({
      code: "AUTHENTICATION_ERROR",
      status: 401,
      message,
    });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "You are not allowed to perform this action") {
    super({
      code: "AUTHORIZATION_ERROR",
      status: 403,
      message,
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super({
      code: "NOT_FOUND",
      status: 404,
      message,
    });
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource conflict") {
    super({
      code: "CONFLICT",
      status: 409,
      message,
    });
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({
      code: "CONFIGURATION_ERROR",
      status: 500,
      message,
      cause,
      expose: false,
    });
  }
}

export class InternalError extends AppError {
  constructor(message = "An unexpected error occurred", cause?: unknown) {
    super({
      code: "INTERNAL_ERROR",
      status: 500,
      message,
      cause,
      expose: false,
    });
  }
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new InternalError("An unexpected error occurred", error);
}
