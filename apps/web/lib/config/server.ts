import "server-only";

export interface ServerEnv {
  openRouterApiKey: string;
}

export function getServerEnv(): ServerEnv {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;

  if (!openRouterApiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  return {
    openRouterApiKey,
  };
}
