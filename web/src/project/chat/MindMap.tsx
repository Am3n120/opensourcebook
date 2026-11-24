import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MindMapLink, MindMapNode, MindMapPiece } from "../../api/types";
import { Icon } from "../../design/Icon";
import { fitMap, layoutMindMap, linksOf, MAP_ASPECT, MAP_LAID_OUT, type PlacedNode } from "../mindMap";
import { Cites, UnknownPieceView, Words } from "../pieceViews";
import type { PieceProps } from "../pieces";
import { useChatActions } from "./actions";

const plain = (text: string) => text.replace(/\[([^\]\n]+)\]\(cite:\d+\)/g, "$1");

/** How far the map can be zoomed in the full view, as a share of its fitted size. */
const ZOOM = { min: 0.6, max: 2.4, step: 0.2 };

/** The inner size of a box, kept up to date as it changes; undefined until it is measured. */
function useBoxSize(el: HTMLElement | null): { w: number; h: number } | undefined {
  const [size, setSize] = useState<{ w: number; h: number }>();
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const style = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
      const h = el.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0");
      setSize((old) => (w > 0 ? (old && old.w === w && old.h === h ? old : { w, h }) : undefined));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [el]);
  return size;
}

/**
 * The map fitted to its box: as wide as the box (and, given a height, no
 * taller than it), times the zoom. Below the width it is laid out for, it is
 * drawn at that width and scaled down, so every name stays where the layout
 * put it. Unmeasured (as in tests), the map is drawn at the box's width.
 */
function Fitted({ size, zoom = 1, height, children }: { size: { w: number; h: number } | undefined; zoom?: number; height?: boolean; children: (style: CSSProperties | undefined) => ReactNode }) {
  if (!size) return <>{children(undefined)}</>;
  const { laid, scale } = fitMap(size, zoom, height);
  return (
    <div className="mmfit" style={{ width: laid * scale, height: (laid / MAP_ASPECT) * scale }}>
      {children({ width: laid, minWidth: 0, transform: scale === 1 ? undefined : `scale(${scale})` })}
    </div>
  );
}

/**
 * A mind map in the chat: how many ideas and links, Fit and the full view
 * at the top; the ideas placed round the central one, joined by their links;
 * and under it the idea that is open, its sentence with its cites and what
 * it connects to, each of which opens in turn. The centre is open first. It
 * answers inside the chat and makes nothing.
 */
export function MindMapPieceView(props: PieceProps<MindMapPiece>) {
  const { piece } = props;
  const nodes = useMemo(() => (Array.isArray(piece.nodes) ? piece.nodes.filter((node) => node && typeof node.id === "string") : []), [piece.nodes]);
  const links = useMemo(() => (Array.isArray(piece.links) ? piece.links.filter((link) => link && typeof link.from === "string" && typeof link.to === "string") : []), [piece.links]);
  const placed = useMemo(() => layoutMindMap(nodes, links), [nodes, links]);
  const [open, setOpen] = useState(nodes[0]?.id);
  const [full, setFull] = useState(false);
  // The map is fitted to the card at any width, from its first draw; Fit puts it back so, in view.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const size = useBoxSize(box);
  const fit = () => {
    box?.scrollTo?.({ left: 0, top: 0 });
  };
  if (nodes.length === 0) return <UnknownPieceView {...props} />;
  const chosen = nodes.find((node) => node.id === open) ?? nodes[0]!;
  const centre = plain(nodes[0]!.text);
  return (
    <figure className="blk mm" role="group" aria-label={`Mind map: ${centre}`}>
      <div className="mm-bar">
        <small>
          {nodes.length} idea{nodes.length === 1 ? "" : "s"} · {links.length} link{links.length === 1 ? "" : "s"}
        </small>
        <span className="sp" />
        <button type="button" className="mm-btn" onClick={fit}>
          Fit
        </button>
        <button type="button" className="mm-btn ic" aria-label="Full view" title="Full view" onClick={() => setFull(true)}>
          <Icon name="grid" />
        </button>
      </div>
      <div className="mmw" role="region" aria-label="The map" tabIndex={0} ref={setBox}>
        <Fitted size={size}>{(style) => <MapDrawing nodes={nodes} links={links} placed={placed} chosen={chosen.id} onOpen={setOpen} style={style} />}</Fitted>
      </div>
      <figcaption className="mmd" aria-live="polite">
        <IdeaDetail {...props} nodes={nodes} links={links} chosen={chosen} onOpen={setOpen} />
      </figcaption>
      {full && <MindMapFull {...props} nodes={nodes} links={links} placed={placed} chosen={chosen} onOpen={setOpen} onClose={() => setFull(false)} />}
    </figure>
  );
}

/** The ideas on their spots and the lines between them; the open idea and its links stand out. */
function MapDrawing({ nodes, links, placed, chosen, onOpen, style }: { nodes: MindMapNode[]; links: MindMapLink[]; placed: PlacedNode[]; chosen: string; onOpen: (id: string) => void; style: CSSProperties | undefined }) {
  const at = new Map(placed.map((spot) => [spot.id, spot]));
  return (
    <div className="mmc" style={style}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {links.map((link, k) => {
          const a = at.get(link.from);
          const b = at.get(link.to);
          if (!a || !b) return null;
          const lit = link.from === chosen || link.to === chosen;
          return <line key={k} className={lit ? "lit" : undefined} x1={a.x} y1={a.y} x2={b.x} y2={b.y} vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      {nodes.map((node) => {
        const spot = at.get(node.id);
        if (!spot) return null;
        return (
          <button key={node.id} type="button" className={`mmn d${Math.min(spot.depth, 2)}`} style={{ left: `${spot.x}%`, top: `${spot.y}%` }} aria-pressed={node.id === chosen} onClick={() => onOpen(node.id)}>
            {plain(node.text)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The open idea: its name, its sentence with its cites, and what it connects
 * to: each other idea by its name, a step along the map, with the link's own
 * words, as the engine sent them, and an arrow for its direction, as a quiet
 * line after it.
 */
function IdeaDetail(props: PieceProps<MindMapPiece> & { nodes: MindMapNode[]; links: MindMapLink[]; chosen: MindMapNode; onOpen: (id: string) => void }) {
  const { piece, nodes, links, chosen, onOpen } = props;
  const name = new Map(nodes.map((node) => [node.id, node.text]));
  const ties = linksOf(chosen.id, links).filter((tie) => name.has(tie.other));
  return (
    <>
      <h4>
        <span className="mm-dot" aria-hidden="true" />
        {plain(chosen.text)}
      </h4>
      {(chosen.detail || chosen.cites?.length || chosen.unchecked) && (
        <p>
          {chosen.detail && <Words text={chosen.detail} {...props} />}
          <Cites of={chosen} {...props} />
        </p>
      )}
      {ties.length > 0 && (
        <div className="mm-ties">
          <small>Connects to</small>
          <ul aria-label={`How ${plain(chosen.text)} connects`}>
            {ties.map(({ link, other, outgoing }, k) => (
              <li key={k}>
                <button type="button" className="mml" onClick={() => onOpen(other)}>
                  {plain(name.get(other)!)}
                </button>
                <small>
                  <span className="mm-dir" role="img" aria-label={outgoing ? "from this idea" : "to this idea"}>
                    {outgoing ? "\u2192" : "\u2190"}
                  </span>{" "}
                  {plain(link.text)}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Cites of={piece} {...props} />
    </>
  );
}

/**
 * The map filling the window: Exit full view and its name at the top, Fit
 * and zoom at the right, the open idea in a side panel with "Ask about this
 * idea", which puts the idea in the chat box for the person's question.
 */
function MindMapFull(props: PieceProps<MindMapPiece> & { nodes: MindMapNode[]; links: MindMapLink[]; placed: PlacedNode[]; chosen: MindMapNode; onOpen: (id: string) => void; onClose: () => void }) {
  const { nodes, links, placed, chosen, onOpen, onClose } = props;
  const chat = useChatActions();
  const [zoom, setZoom] = useState(1);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const size = useBoxSize(box);
  const exit = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    exit.current?.focus();
    const keys = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);
  const fit = () => {
    setZoom(1);
    box?.scrollTo?.({ left: 0, top: 0 });
  };
  const by = (d: number) => setZoom((z) => Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round((z + d) * 10) / 10)));
  return createPortal(
    <div className="mmfull" role="dialog" aria-modal="true" aria-label={`Mind map: ${plain(nodes[0]!.text)}, full view`}>
      <header className="mmfull-hd">
        <button ref={exit} type="button" className="mm-btn" onClick={onClose}>
          <Icon name="compact" />
          Exit full view
        </button>
        <b>
          {plain(nodes[0]!.text)} · {nodes.length} idea{nodes.length === 1 ? "" : "s"}
        </b>
        <span className="sp" />
        <button type="button" className="mm-btn" onClick={fit}>
          Fit
        </button>
        <button type="button" className="mm-btn ic" aria-label="Zoom out" disabled={zoom <= ZOOM.min} onClick={() => by(-ZOOM.step)}>
          −
        </button>
        <button type="button" className="mm-btn ic" aria-label="Zoom in" disabled={zoom >= ZOOM.max} onClick={() => by(ZOOM.step)}>
          +
        </button>
      </header>
      <div className="mmfull-body">
        <div className="mmfull-map" ref={setBox} role="region" aria-label="The map" tabIndex={0}>
          <Fitted size={size} zoom={zoom} height>
            {(style) => <MapDrawing nodes={nodes} links={links} placed={placed} chosen={chosen.id} onOpen={onOpen} style={style ?? (zoom !== 1 ? { width: `${zoom * 100}%`, minWidth: `${zoom * MAP_LAID_OUT}px` } : undefined)} />}
          </Fitted>
        </div>
        <aside className="mmfull-side mmd" aria-live="polite">
          <IdeaDetail {...props} />
          {chat && (
            <button
              type="button"
              className="obtn mmfull-ask"
              onClick={() => {
                onClose();
                chat.fill(`About ${plain(chosen.text)}: `);
              }}
            >
              Ask about this idea
            </button>
          )}
        </aside>
      </div>
    </div>,
    document.body,
  );
}
