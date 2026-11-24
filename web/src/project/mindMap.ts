import type { MindMapLink, MindMapNode } from "../api/types";

/** Where one idea sits on a drawn mind map, in percent of the map's box. */
export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  /** Links between it and the centre: 0 for the centre itself. */
  depth: number;
}

/** How far the outermost ring sits from the centre, in percent of the box's width and height: wider than tall, as names are. */
const OUTER_X = 41;
const OUTER_Y = 40;
/** The first ring sits at least this far out, as a share of the outermost, so its ideas clear the centre's name. */
const INNER = 0.55;

/**
 * A radial layout of a mind map (engine/docs/api.md, "Reply blocks"): the
 * first node in the middle, the ideas linked to it on a ring around it, and
 * each idea further out placed within the slice of the one it hangs from,
 * so related ideas sit side by side. A slice is as wide as the ideas that
 * hang from it need. Links are read both ways for the layout. An idea the
 * links do not reach (the engine sends none) goes on the first ring.
 */
export function layoutMindMap(nodes: readonly (Pick<MindMapNode, "id"> & { text?: string })[], links: readonly Pick<MindMapLink, "from" | "to">[]): PlacedNode[] {
  const centre = nodes[0];
  if (!centre) return [];
  const known = new Set(nodes.map((node) => node.id));
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const children = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const depth = new Map([[centre.id, 0]]);
  const queue = [centre.id];
  const visit = (parent: string, child: string) => {
    depth.set(child, depth.get(parent)! + 1);
    children.get(parent)!.push(child);
    queue.push(child);
  };
  while (queue.length) {
    const at = queue.shift()!;
    const next = links
      .flatMap((link) => (link.from === at ? [link.to] : link.to === at ? [link.from] : []))
      .filter((id) => known.has(id) && !depth.has(id))
      .sort((a, b) => order.get(a)! - order.get(b)!);
    for (const id of new Set(next)) visit(at, id);
    if (!queue.length) {
      const stray = nodes.find((node) => !depth.has(node.id));
      if (stray) visit(centre.id, stray.id);
    }
  }
  const deepest = Math.max(1, ...depth.values());
  const leaves = new Map<string, number>();
  const count = (id: string): number => {
    const kids = children.get(id)!;
    const n = kids.length ? kids.reduce((sum, kid) => sum + count(kid), 0) : 1;
    leaves.set(id, n);
    return n;
  };
  count(centre.id);
  const placed: PlacedNode[] = [{ id: centre.id, x: 50, y: 50, depth: 0 }];
  // Each idea gets a slice of the circle, split among the ideas hanging from it; the first starts at the top.
  const place = (id: string, from: number, width: number) => {
    let start = from;
    for (const kid of children.get(id)!) {
      const share = (width * leaves.get(kid)!) / leaves.get(id)!;
      const angle = start + share / 2;
      const d = depth.get(kid)!;
      const ring = deepest === 1 ? 1 : INNER + ((1 - INNER) * (d - 1)) / (deepest - 1);
      placed.push({
        id: kid,
        x: round(50 + OUTER_X * ring * Math.sin(angle)),
        y: round(50 - OUTER_Y * ring * Math.cos(angle)),
        depth: d,
      });
      place(kid, start, share);
      start += share;
    }
  };
  // One or two ideas round the centre sit beside it, where a name has the most room, rather than above it.
  const first = children.get(centre.id)!.length;
  place(centre.id, first > 0 && first <= 2 ? Math.PI / 2 - Math.PI / first : 0, Math.PI * 2);
  const spots = nodes.map((node) => placed.find((spot) => spot.id === node.id)!);
  return spread(
    spots,
    nodes.map((node, index) => nameBox(node.text ?? "", index === 0)),
  );
}

/** The box the map is drawn at its narrowest, in pixels, which the sizes of names are read against. */
const BOX = { width: 540, height: 360 };
/** The narrowest the map is laid out at, in pixels; a smaller box draws it at this width, scaled down. */
export const MAP_LAID_OUT = BOX.width;
/** The map's width over its height. */
export const MAP_ASPECT = BOX.width / BOX.height;

/**
 * How a map is drawn to fit a box of `size` pixels: the width it is laid
 * out at and the scale it is drawn at. It fits the box's width (and, with
 * `height`, its height too), times the zoom; below its narrowest it is laid
 * out at that and scaled down, so every name stays where the layout put it.
 */
export function fitMap(size: { w: number; h: number }, zoom = 1, height = false): { laid: number; scale: number } {
  const fit = height && size.h > 0 ? Math.min(size.w, size.h * MAP_ASPECT) : size.w;
  const laid = Math.max(MAP_LAID_OUT, fit);
  return { laid, scale: (fit / laid) * zoom };
}
/** Room kept between two names, in pixels. */
const GAP = 6;

/** About how much room a name takes on the map, in percent of the box: a pill of one line, or two when it is long. */
export function nameBox(text: string, centre = false): { w: number; h: number } {
  const perChar = centre ? 8.2 : 7.2;
  const most = centre ? 160 : 140;
  const words = text.length * perChar;
  const lines = Math.min(3, Math.max(1, Math.ceil(words / (most - 20))));
  const width = Math.min(words + 22, most);
  const height = lines * 18 + (centre ? 14 : 10);
  return { w: (width / BOX.width) * 100, h: (height / BOX.height) * 100 };
}

/**
 * Names that would cover each other are moved apart, the shorter way
 * (mostly up or down, as names are wide), a little at a time until none
 * do or it stops helping. The centre stays where it is, and every name
 * stays inside the box.
 */
function spread(spots: PlacedNode[], boxes: { w: number; h: number }[]): PlacedNode[] {
  const out = spots.map((spot) => ({ ...spot }));
  const gapX = (GAP / BOX.width) * 100;
  const gapY = (GAP / BOX.height) * 100;
  for (let pass = 0; pass < 120; pass++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overX = (boxes[i]!.w + boxes[j]!.w) / 2 + gapX - Math.abs(dx);
        const overY = (boxes[i]!.h + boxes[j]!.h) / 2 + gapY - Math.abs(dy);
        if (overX <= 0 || overY <= 0) continue;
        moved = true;
        // Pixels decide the shorter way out, since a percent across is longer than a percent down.
        const across = (overX * BOX.width) / 100 < (overY * BOX.height) / 100;
        const sign = (across ? dx : dy) === 0 ? (j % 2 ? 1 : -1) : Math.sign(across ? dx : dy);
        const step = (across ? overX : overY) / (i === 0 ? 1 : 2);
        if (across) {
          if (i !== 0) a.x -= sign * step;
          b.x += sign * step;
        } else {
          if (i !== 0) a.y -= sign * step;
          b.y += sign * step;
        }
      }
    }
    for (const [k, spot] of out.entries()) {
      if (k === 0) continue;
      spot.x = round(Math.min(100 - boxes[k]!.w / 2, Math.max(boxes[k]!.w / 2, spot.x)));
      spot.y = round(Math.min(100 - boxes[k]!.h / 2, Math.max(boxes[k]!.h / 2, spot.y)));
    }
    if (!moved) break;
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The links of one idea, each read as a sentence from its own side: "Sunlight powers Photosynthesis". */
export function linksOf(id: string, links: readonly MindMapLink[]): Array<{ link: MindMapLink; other: string; outgoing: boolean }> {
  return links.flatMap(
    (link): Array<{ link: MindMapLink; other: string; outgoing: boolean }> =>
      link.from === id ? [{ link, other: link.to, outgoing: true }] : link.to === id ? [{ link, other: link.from, outgoing: false }] : [],
  );
}
