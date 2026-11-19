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
    <form action={formAction} className="mt-4 space-y-3">
      <div>
        <label
          htmlFor="displayName"
          className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Display name
        </label>
        <input
          id="displayName"
          name="displayName"
          type="text"
          maxLength={40}
          defaultValue={state.value}
          placeholder="How you appear on the leaderboard"
          className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50 dark:placeholder:text-zinc-500 dark:focus:border-zinc-500"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {state.message && (
          <p
            role="status"
            className={`text-sm ${
              state.ok
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
