import type { CSSProperties } from "react";
import { Icon } from "./Icon";
import { lookFor, type FormatLike } from "./formatLook";

/**
 * A format badge: label, colour slot and icon from the engine's descriptors.
 * Shows the label exactly as the descriptor writes it (lower case).
 */
export function FormatBadge({ id, formats, icon = false }: { id: string; formats: readonly FormatLike[]; icon?: boolean }) {
  const look = lookFor(formats, id);
  const style = {
    "--fmt-bg": `var(--fmt-${look.colorSlot}-bg)`,
    "--fmt-fg": `var(--fmt-${look.colorSlot}-fg)`,
  } as CSSProperties;
  return (
    <span className="b" data-format={look.id} style={style}>
      {icon && <Icon name={look.icon} />}
      {look.label}
    </span>
  );
}
