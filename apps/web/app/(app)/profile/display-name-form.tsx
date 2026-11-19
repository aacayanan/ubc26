"use client";

import { useActionState } from "react";
import { saveDisplayName, type DisplayNameState } from "./actions";

const initialState: DisplayNameState = { ok: false, message: null, value: "" };

export default function DisplayNameForm({
  initialValue,
}: {
  initialValue: string;
}) {
  const [state, formAction, pending] = useActionState(saveDisplayName, {
    ...initialState,
    value: initialValue,
  });

  return (
    <form
      action={formAction}
      className="mt-6 space-y-3 border-t border-hairline pt-6"
    >
      <div>
        <label htmlFor="displayName" className="t-label mb-2 block text-faint">
          Display name
        </label>
        <input
          id="displayName"
          name="displayName"
          type="text"
          maxLength={40}
          defaultValue={state.value}
          placeholder="How you appear on the leaderboard"
          aria-describedby={state.message ? "display-name-status" : undefined}
          className="field"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="btn btn-solid btn-sm"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {state.message ? (
          <p
            id="display-name-status"
            role="status"
            className={`text-[0.8125rem] ${
              state.ok ? "text-muted" : "text-magenta"
            }`}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
