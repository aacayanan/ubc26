import Link from "next/link";

/**
 * The mark: two slanted bars, the second one slipping out of register — a
 * glitch held still. Drawn, not a typeface glyph.
 */
export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 22 18"
      className={className}
      aria-hidden="true"
      fill="none"
    >
      <defs>
        <linearGradient id="logo-ink" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ff2e93" />
        </linearGradient>
      </defs>
      <path d="M6.2 1.6 1 16.4h3.3L9.5 1.6H6.2Z" fill="url(#logo-ink)" />
      <path
        d="M15.4 1.6 10.2 16.4h3.3L18.7 1.6h-3.3Z"
        fill="url(#logo-ink)"
        opacity="0.55"
      />
    </svg>
  );
}

export default function Logo({
  href = "/",
  showWordmark = true,
}: {
  href?: string;
  showWordmark?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-2.5 text-ink"
      aria-label="Zelto — home"
    >
      <LogoMark className="h-[18px] w-[22px] shrink-0" />
      {showWordmark ? (
        <span className="whitespace-nowrap text-[0.9375rem] font-medium tracking-[-0.015em]">
          Zelto
        </span>
      ) : null}
    </Link>
  );
}
