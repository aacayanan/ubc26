import {
  AuthenticationError,
  ConflictError,
  InternalError,
  ValidationError,
} from "@/lib/server/errors/app-error";
import { withApiErrorHandling } from "@/lib/server/http/api-error";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  MIN_PASSWORD_LENGTH,
  USERNAME_PATTERN,
  USERNAME_RULE,
  needsAccountSetup,
  usernameToLoginEmail,
} from "@/lib/auth/wallet-account";

/**
 * Finish a Phantom sign-up: POST /api/account/complete
 *   Body: { "username": string, "password": string }
 *
 * Attaches a username + password login to the signed-in wallet account, so
 * the same account (and its already-linked wallet) can sign back in without
 * Phantom. Only a wallet account with no password login may call this; the
 * caller is identified from the session, never from the body.
 */
export async function POST(request: Request) {
  return withApiErrorHandling(request, async () => {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new AuthenticationError("Sign in with Phantom first");
    if (!needsAccountSetup(user)) {
      throw new ValidationError("This account already has a password login");
    }

    let body: { username?: unknown; password?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new ValidationError("Request body must be valid JSON");
    }

    const username =
      typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!USERNAME_PATTERN.test(username)) {
      throw new ValidationError(`Username must be ${USERNAME_RULE}`);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }

    const admin = createSupabaseAdminClient();
    const { error: authError } = await admin.auth.admin.updateUserById(
      user.id,
      {
        email: usernameToLoginEmail(username),
        // The address is synthetic and can never receive mail; confirm it here.
        email_confirm: true,
        password,
        user_metadata: { ...user.user_metadata, username },
      },
    );
    if (authError) {
      const message = authError.message.toLowerCase();
      if (
        authError.code === "email_exists" ||
        message.includes("already been registered")
      ) {
        throw new ConflictError("That username is taken. Pick another.");
      }
      if (authError.code === "weak_password") {
        throw new ValidationError(authError.message);
      }
      throw new InternalError(
        "Could not finish creating your account",
        authError,
      );
    }

    const { error: profileError } = await admin
      .from("users")
      .update({ display_name: username })
      .eq("id", user.id);
    if (profileError) {
      throw new InternalError("Could not save your username", profileError);
    }

    return Response.json(
      { ok: true, username },
      { headers: { "cache-control": "no-store" } },
    );
  });
}
