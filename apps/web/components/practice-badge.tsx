import { Status } from "@/components/ui";

/**
 * Status pill for accounts that cannot stake on a live round: either no Solana
 * wallet is linked ("No wallet"), or a wallet-identified account has opted into
 * paper mode ("Practice"). Rounds are created by the admin, never by users —
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
      className={className}
      title={
        label === "Practice"
          ? "Practice mode: voting and browsing only, no stake is placed"
          : "Link a Solana wallet to stake on live rounds"
      }
    >
      <Status tone="amber">
        {label}
        <span className="sr-only">
          {label === "Practice"
            ? " — browsing and voting only, no stake is placed"
            : " — link a Solana wallet to stake on live rounds"}
        </span>
      </Status>
    </span>
  );
}
