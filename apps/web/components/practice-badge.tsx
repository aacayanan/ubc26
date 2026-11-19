/**
 * Status pill for accounts that cannot join live rounds: either no Solana
 * wallet is linked ("No wallet"), or a funded account has opted into paper
 * trading ("Practice"). Rounds are created by the admin, never by users —
 * users only join them.
 */
export default function PracticeBadge({
  label = "Practice",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      title={
        label === "Practice"
          ? "Practice mode: joining is paper only, no prompt session starts"
          : "Link a Solana wallet to join live rounds"
      }
      className={`inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400 ${className}`}
    >
      {label}
    </span>
  );
}
