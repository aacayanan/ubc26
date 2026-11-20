/**
 * Authored icon set. One stroke weight (1.3), one family, no font glyphs
 * standing in for controls.
 */

type IconProps = { className?: string };

export function ChevronRight({ className = "size-4" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/** The double chevron the primary CTA carries. */
export function ChevronsRight({ className = "size-4" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 3.5 8 8l-4.5 4.5" />
      <path d="M8 3.5 12.5 8 8 12.5" />
    </svg>
  );
}

export function ArrowRight({ className = "size-4" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 8h11" />
      <path d="M9.5 4 13.5 8l-4 4" />
    </svg>
  );
}

/** A circled question mark — the affordance for an explanation on hover. */
export function HelpCircle({ className = "size-4" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.15 6.1a1.9 1.9 0 1 1 2.35 1.85c-.35.12-.5.4-.5.75v.35" />
      <path d="M8 11.5h.01" />
    </svg>
  );
}
