import type { CSSProperties } from "react";
import type { Glimpse } from "../api/types";
import { mediaUrl } from "../player/media";
import { lookFor, type FormatLike } from "./formatLook";
import { FormatTile } from "./FormatTile";

/**
 * The face of a made thing in a list: a frame of its video or its picture
 * when it has one, else the first words it says on its format's colour,
 * else just its format tile. What shows is what the format put in its glimpse.
 * `thumb` is the same face small, for a row in a list.
 */
export function GlimpseFace({
  type,
  glimpse,
  formats,
  thumb,
  showTile = true,
}: {
  type: string;
  glimpse?: Glimpse | undefined;
  formats: readonly FormatLike[];
  thumb?: boolean;
  showTile?: boolean;
}) {
  const look = lookFor(formats, type);
  const style = { "--fmt-bg": `var(--fmt-${look.colorSlot}-bg)`, "--fmt-fg": `var(--fmt-${look.colorSlot}-fg)` } as CSSProperties;
  const src = mediaUrl(glimpse?.media?.url);
  return (
    <span className={thumb ? "face thumb" : "face"} style={style} aria-hidden="true">
      {src && glimpse?.media?.kind === "video" ? (
        // The frame a second in, not the first one, which is often blank.
        <video src={`${src}#t=1`} preload="metadata" muted playsInline tabIndex={-1} />
      ) : src && glimpse?.media?.kind === "image" ? (
        <img src={src} alt="" loading="lazy" />
      ) : glimpse?.text ? (
        <span className="said">{glimpse.text}</span>
      ) : null}
      {showTile && <FormatTile id={type} formats={formats} size="sm" solid />}
    </span>
  );
}
