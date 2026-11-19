/**
 * Marks accounts that have not linked a Solana wallet. They can make
 * predictions on rounds others create, but cannot create rounds — only
 * funded, wallet-linked accounts can (see CLAUDE.md: points and leaderboards
 * only, no real money).
 */
export default function PracticeBadge({
  className = "",
}: {
  className?: string;
}) {
  return (
    <span
      title="Practice mode: you can predict, but not create rounds"
      className={`inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400 ${className}`}
    >
      Practice
    </span>
  );
}
