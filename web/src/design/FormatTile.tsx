import type { CSSProperties } from "react";
import { Icon } from "./Icon";
import { lookFor, type FormatLike } from "./formatLook";

/**
 * A format as a small square tile: its icon on its colour slot, both from
 * the engine's descriptors. `solid` is a thing that has been made; `done`
 * adds the done tick.
 */
export function FormatTile({ id, formats, size = "md", solid, done }: { id: string; formats: readonly FormatLike[]; size?: "sm" | "md" | "lg"; solid?: boolean; done?: boolean }) {
  const look = lookFor(formats, id);
  const style = { "--fmt-bg": `var(--fmt-${look.colorSlot}-bg)`, "--fmt-fg": `var(--fmt-${look.colorSlot}-fg)` } as CSSProperties;
  return (
    <span className={`ftile ${size}${solid ? " solid" : ""}`} style={style} data-format={look.id} title={look.label}>
      <Icon name={look.icon} />
      {done && (
        <span className="tick">
          <Icon name="check" />
        </span>
      )}
    </span>
  );
}
