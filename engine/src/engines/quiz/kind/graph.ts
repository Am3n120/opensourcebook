/**
 * Draw a line on a graph: the person puts two points on a grid and the line
 * through them is their answer (a rate, a relation the source gives, a line
 * from its numbers). Points sit on the grid's steps, so a right line is
 * exactly right.
 *
 * Fields: `axes` `{ x: { min, max, step, label? }, y: { ... } }`; `line`, two
 * different grid points the right line goes through, `[[x1, y1], [x2, y2]]`.
 * Response: `{ "points": [[x, y], [x, y]] }`. Right when both points are on
 * the right line and are not the same point; a line is right or not.
 */
import { isRecord, text, type KindIssue, type QuestionKind } from "../kinds";
import type { QuizQuestion } from "../schema";

/** At most this many steps along an axis, so every grid point is big enough to tap. */
const MAX_STEPS = 24;

export interface Axis {
  min: number;
  max: number;
  step: number;
  label?: string;
}

type Point = [number, number];

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readAxis(raw: unknown): Axis {
  const axis = isRecord(raw) ? raw : {};
  const number = (value: unknown) => (finite(value) ? value : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : NaN);
  const label = text(axis.label);
  return { min: number(axis.min), max: number(axis.max), step: number(axis.step ?? 1), ...(label ? { label } : {}) };
}

function readPoint(raw: unknown): Point | undefined {
  return Array.isArray(raw) && raw.length === 2 && finite(raw[0]) && finite(raw[1]) ? [raw[0], raw[1]] : undefined;
}

const axes = (question: QuizQuestion): { x: Axis; y: Axis } => {
  const raw = isRecord(question.axes) ? question.axes : {};
  return { x: readAxis(raw.x), y: readAxis(raw.y) };
};

const line = (question: QuizQuestion): Point[] => (Array.isArray(question.line) ? question.line.map(readPoint).filter((point): point is Point => point !== undefined) : []);

/** How near counts as the same, for numbers on a grid of this step. */
const near = (a: number, b: number, step: number) => Math.abs(a - b) <= Math.abs(step) * 1e-6;

/** Whether `value` is on the axis: within it and on one of its steps. */
function onAxis(value: number, axis: Axis): boolean {
  if (value < axis.min - axis.step * 1e-6 || value > axis.max + axis.step * 1e-6) return false;
  const steps = (value - axis.min) / axis.step;
  return Math.abs(steps - Math.round(steps)) <= 1e-6;
}

/** Whether `point` is on the line through `a` and `b`, as near as the grid can tell. */
export function onLine(point: Point, [a, b]: [Point, Point], grid: { x: Axis; y: Axis }): boolean {
  const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  return Math.abs(cross) <= grid.x.step * grid.y.step * 1e-6;
}

/** The line in words: y = mx + c, or x = k when it stands upright. */
export function lineWords([a, b]: [Point, Point], grid: { x: Axis; y: Axis }): string {
  const named = (axis: Axis, fallback: string) => axis.label ?? fallback;
  if (near(a[0], b[0], grid.x.step)) return `the upright line ${named(grid.x, "x")} = ${round(a[0])}`;
  const slope = (b[1] - a[1]) / (b[0] - a[0]);
  const intercept = a[1] - slope * a[0];
  const c = round(intercept);
  return `the line through (${round(a[0])}, ${round(a[1])}) and (${round(b[0])}, ${round(b[1])}), y = ${round(slope)}x ${c < 0 ? "−" : "+"} ${Math.abs(c)}`;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

function axisIssues(axis: Axis, at: string): KindIssue[] {
  if (![axis.min, axis.max, axis.step].every(Number.isFinite) || axis.min >= axis.max || axis.step <= 0) {
    return [{ path: at, code: "axis", message: "an axis is {\"min\":..,\"max\":..,\"step\":..} with min below max and a step above 0" }];
  }
  const steps = (axis.max - axis.min) / axis.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) return [{ path: `${at}.step`, code: "step", message: "max − min must be a whole number of steps" }];
  if (steps > MAX_STEPS) return [{ path: `${at}.step`, code: "step", message: `at most ${MAX_STEPS} steps along an axis, so each grid point can be tapped; use a larger step` }];
  if (axis.label !== undefined && axis.label.length > 40) return [{ path: `${at}.label`, code: "too_long", message: "an axis label is at most 40 characters" }];
  return [];
}

function givenPoints(response: unknown): Point[] | undefined {
  if (!isRecord(response) || !Array.isArray(response.points)) return undefined;
  const points = response.points.map(readPoint);
  return points.length === 2 && points.every((point) => point !== undefined) ? (points as Point[]) : undefined;
}

export const graphKind: QuestionKind = {
  id: "graph",
  label: "Draw a line on a graph",
  description: "Draw a straight line on a grid by placing two points on it.",
  fields: {
    axes: {
      type: "object",
      description: "The grid: each axis's range, its step (grid points are on the steps) and an optional label.",
      properties: {
        x: { type: "object", properties: { min: { type: "number" }, max: { type: "number" }, step: { type: "number" }, label: { type: "string" } }, required: ["min", "max", "step"] },
        y: { type: "object", properties: { min: { type: "number" }, max: { type: "number" }, step: { type: "number" }, label: { type: "string" } }, required: ["min", "max", "step"] },
      },
      required: ["x", "y"],
    },
    line: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      description: "Two different grid points the right line goes through, [[x1, y1], [x2, y2]].",
    },
  },
  guidance: `"kind":"graph", "axes":{"x":{"min":0,"max":10,"step":1,"label":"..."},"y":{"min":0,"max":50,"step":5,"label":"..."}} (each axis at most ${MAX_STEPS} steps; grid points sit on the steps), "line":[[x1,y1],[x2,y2]] (two different grid points the right line goes through). The person draws a straight line by putting two points on the grid. Use it for a relation the sources give with numbers (a rate, a straight-line relation, a line through values they state); the prompt gives what is needed to draw it, and the axes are wide enough for it. Choose a line that passes through at least two grid points well apart, so it can be drawn exactly.`,
  normalize(raw) {
    const grid = isRecord(raw.axes) ? raw.axes : {};
    const points = Array.isArray(raw.line) ? raw.line.map((point) => (Array.isArray(point) ? point.map((value) => (typeof value === "string" ? Number(value) : value)) : point)).map(readPoint) : [];
    return { axes: { x: readAxis(grid.x), y: readAxis(grid.y) }, line: points.filter((point): point is Point => point !== undefined) };
  },
  check(question) {
    const grid = axes(question);
    const issues = [...axisIssues(grid.x, ".axes.x"), ...axisIssues(grid.y, ".axes.y")];
    const points = line(question);
    if (points.length !== 2) return [...issues, { path: ".line", code: "line", message: "line is two grid points, [[x1, y1], [x2, y2]]" }];
    if (issues.length > 0) return issues;
    points.forEach((point, at) => {
      if (!onAxis(point[0], grid.x) || !onAxis(point[1], grid.y)) issues.push({ path: `.line[${at}]`, code: "off_grid", message: "each point of the line is a grid point inside the axes (on a step of each)" });
    });
    if (near(points[0]![0], points[1]![0], grid.x.step) && near(points[0]![1], points[1]![1], grid.y.step)) issues.push({ path: ".line", code: "line", message: "the two points must be different" });
    return issues;
  },
  describeAnswer(question) {
    const points = line(question);
    return points.length === 2 ? lineWords(points as [Point, Point], axes(question)) : "";
  },
  grade(question, response) {
    const points = givenPoints(response);
    if (!points) return { fraction: 0, answered: false };
    const grid = axes(question);
    const right = line(question) as [Point, Point];
    const apart = !(near(points[0]![0], points[1]![0], grid.x.step) && near(points[0]![1], points[1]![1], grid.y.step));
    return { fraction: apart && right.length === 2 && points.every((point) => onLine(point, right, grid)) ? 1 : 0, answered: true };
  },
  describeShown(question) {
    const { x, y } = axes(question);
    const axisWords = (axis: Axis, name: string) => `${axis.label ? `${axis.label} (${name})` : name} from ${axis.min} to ${axis.max} in steps of ${axis.step}`;
    return [`A grid to draw a straight line on: ${axisWords(x, "x")}; ${axisWords(y, "y")}`];
  },
  describeResponse(question, response) {
    const points = givenPoints(response);
    if (!points) return undefined;
    const grid = axes(question);
    const apart = !(near(points[0]![0], points[1]![0], grid.x.step) && near(points[0]![1], points[1]![1], grid.y.step));
    return apart ? lineWords(points as [Point, Point], grid) : `one point, (${points[0]![0]}, ${points[0]![1]}), twice`;
  },
};
