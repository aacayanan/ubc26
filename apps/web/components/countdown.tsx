"use client";

import { useEffect, useRef, useState } from "react";
import { describeDeadline } from "@/lib/countdown";

/**
 * A ticking deadline readout (F9).
 *
 * Three things make this correct rather than decorative:
 *
 *   * **It re-derives from the clock every tick.** The state is "the current
 *     time", not a decremented counter, so a tab that was backgrounded (where
 *     browsers throttle timers) snaps back to the truth on its next tick instead
 *     of drifting behind. A refresh is just another tick.
 *   * **Server and first client paint agree.** The server renders a value from
 *     the deadline it was given; the client re-renders immediately with its own
 *     clock. `suppressHydrationWarning` covers the at-most-one-second gap, so the
 *     readout never flashes a placeholder.
 *   * **It reports expiry upward, once.** `onExpire` lets the list refetch when a
 *     deadline passes, so a round that is no longer actionable stops being shown
 *     as though it were — the same rule the server applies.
 */
export function CountdownReadout({
  deadline,
  onExpire,
  className,
}: {
  deadline: string;
  onExpire?: () => void;
  className?: string;
}) {
  const [now, setNow] = useState(() => new Date());
  const expiredRef = useRef(false);

  const countdown = describeDeadline(deadline, now);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!countdown.expired || expiredRef.current) return;
    expiredRef.current = true;
    // An expired-on-arrival round is the server's problem to filter, not a
    // reason to refetch every time the list mounts.
    if (countdown.invalid) return;
    onExpire?.();
  }, [countdown.expired, countdown.invalid, onExpire]);

  return (
    <span
      className={className}
      // A per-second live region would be pure noise; the expiry transition is
      // what matters, and that is what `onExpire` acts on.
      role="timer"
      aria-live="off"
      suppressHydrationWarning
    >
      {countdown.text}
    </span>
  );
}
