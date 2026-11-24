import { useState, type MouseEvent } from "react";
import type { Axis, Response } from "../quizGrade";
import type { PieceProps } from "./piece";

type Point = [number, number];

const pointsOf = (r: Response | undefined) => (r as { points?: Point[] } | undefined)?.points;

const W = 320;
const H = 240;
const PAD = 34;
/** Room above the grid for the upright axis's label. */
const TOP = 22;

/** Ticks along an axis: every step when there are few, else every few steps. */
function ticks(axis: Axis): number[] {
  const steps = Math.round((axis.max - axis.min) / axis.step);
  const every = Math.max(1, Math.ceil(steps / 10));
  return Array.from({ length: Math.floor(steps / every) + 1 }, (_, i) => round(axis.min + i * every * axis.step));
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** The value of the grid step nearest `v`, kept inside the axis. */
function snap(v: number, axis: Axis): number {
  const steps = Math.round((v - axis.min) / axis.step);
  return round(Math.min(axis.max, Math.max(axis.min, axis.min + steps * axis.step)));
}

/** The two ends, at the grid's edges, of the line through a and b. */
function across([a, b]: Point[], x: Axis, y: Axis): Point[] | undefined {
  if (!a || !b || (a[0] === b[0] && a[1] === b[1])) return undefined;
  if (a[0] === b[0]) return [[a[0], y.min], [a[0], y.max]];
  const m = (b[1] - a[1]) / (b[0] - a[0]);
  return [
    [x.min, a[1] + m * (x.min - a[0])],
    [x.max, a[1] + m * (x.max - a[0])],
  ];
}

/**
 * Draw a line on a graph: a grid where each tap puts a point on the nearest
 * grid point (a third tap moves the older one), or the points typed in. The
 * line through the two is drawn as it will be checked. Once checked, the
 * right line is drawn beside it.
 */
export function Graph({ q, response, reveal, onAnswer }: PieceProps) {
  const axes = q.axes;
  const given = pointsOf(response);
  // What is in the boxes, as typed; a point is placed once both its numbers read.
  const [boxes, setBoxes] = useState<string[][]>([["", ""], ["", ""]]);
  if (!axes) return null;
  const { x, y } = axes;
  const read = (t: string | undefined) => (t !== undefined && t.trim() !== "" && Number.isFinite(Number(t.replace(",", "."))) ? Number(t.replace(",", ".")) : undefined);
  const placed = boxes.map((b) => [read(b[0]), read(b[1])]).filter((p): p is Point => p[0] !== undefined && p[1] !== undefined);
  const points = given ?? placed;
  const sx = (v: number) => PAD + ((v - x.min) / (x.max - x.min)) * (W - PAD - 10);
  const sy = (v: number) => H - PAD - ((v - y.min) / (y.max - y.min)) * (H - PAD - TOP);
  // A tap fills the first point not yet placed; with both placed, the older goes.
  const put = (p: Point) =>
    setBoxes((now) => {
      const tapped = [String(p[0]), String(p[1])];
      const open = now.findIndex((b) => read(b[0]) === undefined || read(b[1]) === undefined);
      return open < 0 ? [now[1]!, tapped] : now.map((b, i) => (i === open ? tapped : b));
    });
  function onTap(e: MouseEvent<SVGSVGElement>) {
    if (given) return;
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const py = ((e.clientY - box.top) / box.height) * H;
    put([snap(x.min + ((px - PAD) / (W - PAD - 10)) * (x.max - x.min), x), snap(y.min + ((H - PAD - py) / (H - PAD - TOP)) * (y.max - y.min), y)]);
  }
  const drawn = across(points, x, y);
  const right = reveal && given && q.line?.length === 2 ? across(q.line, x, y) : undefined;
  const steps = (axis: Axis) => Array.from({ length: Math.round((axis.max - axis.min) / axis.step) + 1 }, (_, i) => round(axis.min + i * axis.step));
  return (
    <div className="qkind">
      <svg className="qgraph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`A grid, ${x.label ?? "x"} from ${x.min} to ${x.max}, ${y.label ?? "y"} from ${y.min} to ${y.max}. Tap two points to draw a line.`} onClick={onTap}>
        <defs>
          <clipPath id={`grid-${q.id}`}>
            <rect x={sx(x.min)} y={sy(y.max)} width={sx(x.max) - sx(x.min)} height={sy(y.min) - sy(y.max)} />
          </clipPath>
        </defs>
        {steps(x).map((v) => (
          <line key={`x${v}`} className="gl" x1={sx(v)} x2={sx(v)} y1={sy(y.min)} y2={sy(y.max)} />
        ))}
        {steps(y).map((v) => (
          <line key={`y${v}`} className="gl" x1={sx(x.min)} x2={sx(x.max)} y1={sy(v)} y2={sy(v)} />
        ))}
        <line className="ax" x1={sx(x.min)} x2={sx(x.max)} y1={sy(y.min)} y2={sy(y.min)} />
        <line className="ax" x1={sx(x.min)} x2={sx(x.min)} y1={sy(y.min)} y2={sy(y.max)} />
        {ticks(x).map((v) => (
          <text key={`tx${v}`} className="tk" x={sx(v)} y={sy(y.min) + 14} textAnchor="middle">
            {v}
          </text>
        ))}
        {ticks(y).map((v) => (
          <text key={`ty${v}`} className="tk" x={sx(x.min) - 5} y={sy(v) + 3} textAnchor="end">
            {v}
          </text>
        ))}
        {x.label && (
          <text className="al" x={sx(x.max)} y={H - 4} textAnchor="end">
            {x.label}
          </text>
        )}
        {y.label && (
          <text className="al" x={sx(x.min)} y={12} textAnchor="middle">
            {y.label}
          </text>
        )}
        <g clipPath={`url(#grid-${q.id})`}>
          {right && <line className="rl" x1={sx(right[0]![0])} y1={sy(right[0]![1])} x2={sx(right[1]![0])} y2={sy(right[1]![1])} />}
          {drawn && <line className="ul" x1={sx(drawn[0]![0])} y1={sy(drawn[0]![1])} x2={sx(drawn[1]![0])} y2={sy(drawn[1]![1])} />}
        </g>
        {points.map((p, i) => (
          <circle key={i} className="pt" cx={sx(p[0])} cy={sy(p[1])} r={5} />
        ))}
      </svg>
      <div className="qpts">
        {[0, 1].map((i) => (
          <span key={i} className="qpt">
            Point {i + 1}: (
            <input
              className="ipt"
              aria-label={`Point ${i + 1} ${x.label ?? "x"}`}
              inputMode="decimal"
              disabled={!!given}
              value={given ? String(given[i]?.[0] ?? "") : boxes[i]![0]}
              onChange={(e) => typed(i, 0, e.target.value)}
            />
            ,
            <input
              className="ipt"
              aria-label={`Point ${i + 1} ${y.label ?? "y"}`}
              inputMode="decimal"
              disabled={!!given}
              value={given ? String(given[i]?.[1] ?? "") : boxes[i]![1]}
              onChange={(e) => typed(i, 1, e.target.value)}
            />
            )
          </span>
        ))}
      </div>
      {!given && (
        <button className="btn small" type="button" disabled={placed.length < 2} onClick={() => onAnswer({ points: placed })}>
          Check the line
        </button>
      )}
    </div>
  );

  function typed(i: number, at: 0 | 1, text: string) {
    setBoxes((now) => now.map((b, k) => (k === i ? (at === 0 ? [text, b[1]!] : [b[0]!, text]) : b)));
  }
}
