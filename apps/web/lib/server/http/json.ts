import "server-only";

import { ValidationError } from "@/lib/server/errors/app-error";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError("Body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("Body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`${label} must be a UUID`);
  }
  return value;
}

export const NO_STORE = { "cache-control": "no-store" } as const;
