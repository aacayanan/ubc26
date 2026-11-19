import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { logger } from "@/lib/server/logging/logger";

export async function GET(request: Request) {
  return withApiErrorHandling(request, async (correlationId) => {
    logger.info("api.health.checked", { correlationId });
    return Response.json(
      { status: "ok", correlationId },
      {
        headers: {
          "x-correlation-id": correlationId,
        },
      },
    );
  });
}
