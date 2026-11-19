"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/server/services/auth/session";
import { updateDisplayName } from "@/lib/server/services/profile/update";

export interface DisplayNameState {
  ok: boolean;
  message: string | null;
  /** Echoed back so the field keeps the user's text on failure. */
  value: string;
}

export async function saveDisplayName(
  _previous: DisplayNameState,
  formData: FormData,
): Promise<DisplayNameState> {
  const raw = formData.get("displayName") ?? "";
  const value = typeof raw === "string" ? raw : "";

  const user = await requireUser();

  try {
    const saved = await updateDisplayName(user.id, value);
    revalidatePath("/profile");
    revalidatePath("/dashboard");
    return {
      ok: true,
      message: saved ? "Display name saved." : "Display name cleared.",
      value: saved ?? "",
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Could not save your display name.",
      value,
    };
  }
}
