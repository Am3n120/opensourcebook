/** The book's outline and the spine down its middle, on a 32 by 32 grid. */
export const MARK_BOOK = "M7 22V10c3-1.5 6-1.5 9 0 3-1.5 6-1.5 9 0v12c-3-1.5-6-1.5-9 0-3-1.5-6-1.5-9 0z";
export const MARK_SPINE = "M16 10v12";

/**
 * The Open Sourcebook mark: a violet rounded tile with a white open book and
 * an amber dot under the spine. Decorative; the link or heading it sits in
 * carries the name.
 */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" style={{ fill: "var(--primary)" }} />
      <path d={MARK_BOOK} style={{ fill: "var(--onPrimary)" }} />
      <path d={MARK_SPINE} strokeWidth="2" style={{ stroke: "var(--primary)" }} />
      <circle cx="16" cy="26" r="2" style={{ fill: "var(--logo-dot)" }} />
    </svg>
  );
}
