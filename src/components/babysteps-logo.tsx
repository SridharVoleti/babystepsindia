type BabystepsLogoProps = {
  className?: string;
  showWordmark?: boolean;
};

export function BabystepsLogo({ className = "", showWordmark = true }: BabystepsLogoProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`} aria-label="Babysteps">
      <svg
        viewBox="0 0 120 88"
        role="img"
        aria-hidden="true"
        className="h-10 w-12 shrink-0"
      >
        <g fill="#FFB000">
          <path d="M18 36c8-11 23-15 33-8 9 6 10 18 4 28-6 10-18 17-28 14-10-3-17-13-16-24 0-4 3-8 7-10Z" />
          <ellipse cx="12" cy="30" rx="5" ry="6" />
          <ellipse cx="18" cy="20" rx="6" ry="7" />
          <ellipse cx="28" cy="13" rx="7" ry="8" />
          <ellipse cx="40" cy="10" rx="8" ry="9" />
          <ellipse cx="53" cy="12" rx="9" ry="10" />
        </g>
        <g fill="#FFB000" transform="translate(59 8) rotate(12 30 36)">
          <path d="M18 36c8-11 23-15 33-8 9 6 10 18 4 28-6 10-18 17-28 14-10-3-17-13-16-24 0-4 3-8 7-10Z" />
          <ellipse cx="12" cy="30" rx="5" ry="6" />
          <ellipse cx="18" cy="20" rx="6" ry="7" />
          <ellipse cx="28" cy="13" rx="7" ry="8" />
          <ellipse cx="40" cy="10" rx="8" ry="9" />
          <ellipse cx="53" cy="12" rx="9" ry="10" />
        </g>
      </svg>
      {showWordmark ? (
        <span className="text-xl font-extrabold tracking-tight text-[#1565C0] sm:text-2xl">
          babysteps
        </span>
      ) : null}
    </span>
  );
}
