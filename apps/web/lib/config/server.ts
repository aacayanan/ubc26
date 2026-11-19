import "server-only";

import { ConfigurationError } from "@/lib/server/errors/app-error";

export interface ServerEnv {
  openRouterApiKey: string;
}

export function getServerEnv(): ServerEnv {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;

  if (!openRouterApiKey) {
    throw new ConfigurationError("Missing OPENROUTER_API_KEY");
  }

  return {
    openRouterApiKey,
  };
}
