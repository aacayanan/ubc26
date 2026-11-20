import { ValidationError } from "@/lib/server/errors/app-error";
import { withApiErrorHandling } from "@/lib/server/http/api-error";

/**
 * Retired: the points pool is gone. Predictions are Devnet SOL wagers, placed
 * through `/api/rounds/[id]/wagers`.
 */
export async function POST(request: Request) {
  return withApiErrorHandling(request, async () => {
    throw new ValidationError(
      "Points stakes are retired. Predictions are placed with Devnet SOL.",
    );
  });
}
