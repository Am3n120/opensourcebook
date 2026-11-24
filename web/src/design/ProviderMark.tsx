import type { Mark } from "../api/types";

/**
 * A provider's or a model maker's logo, as the engine passes it on from the
 * agent's adapter (engine/docs/api.md, "Providers"): one filled path in its
 * brand colour, or in the text's colour where the brand's mark is black or
 * white only. One with no logo gets its initial on a tinted tile, so a new
 * provider never needs one to work. Nothing here names a provider.
 */
const TINTS = ["#6C5CE7", "#0F766E", "#2563EB", "#B45309", "#B42318", "#556277"];

export function ProviderMark({ mark, label, size = 16, dim }: { mark?: Mark; label: string; size?: number; dim?: boolean }) {
  const style = { width: size, height: size, ...(dim ? { opacity: 0.4, filter: "grayscale(1)" } : {}) };
  if (mark) {
    return (
      <svg className="pmark" viewBox="0 0 24 24" style={{ ...style, color: mark.color }} fill="currentColor" aria-hidden="true">
        <path d={mark.path} />
      </svg>
    );
  }
  const tint = TINTS[[...label].reduce((sum, c) => sum + c.charCodeAt(0), 0) % TINTS.length]!;
  return (
    <span className="pmark mono" style={{ ...style, background: tint, fontSize: Math.round(size * 0.62) }} aria-hidden="true">
      {label.trim().charAt(0).toUpperCase()}
    </span>
  );
}
