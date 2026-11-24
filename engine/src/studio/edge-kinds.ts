/**
 * The kinds of link between plan items the plan runner knows (`plan_edges.kind`).
 * An edge goes from an earlier item to a later one, and its kind says how the
 * runner treats the earlier item when it makes the later one:
 *
 *   - `assumes`: the later item may rely on what the earlier one made, as on
 *     anything in an earlier stage.
 *   - `input`: the earlier item's output and the result the person recorded
 *     on it are handed to the later item as an input, named by the kind.
 *
 * Edge kinds stay open text: a kind not registered here is read as an
 * input. Registering one names it in words for the clients' pick list
 * (`GET /v1/edge-kinds`) without touching the runner.
 */

/** How the runner reads an edge of a kind. */
export type EdgeReading = "assumes" | "input";

export interface EdgeKind {
  /** What is stored in `plan_edges.kind`: lower snake or camel case. */
  id: string;
  /** Sentence case, said of the later item ("Fixes" the earlier one). */
  label: string;
  /** One plain line on what the link does. */
  about: string;
  reads: EdgeReading;
}

export class EdgeKindRegistry {
  private readonly kinds = new Map<string, EdgeKind>();

  register(kind: EdgeKind): this {
    if (!/^[a-z][A-Za-z0-9_]{0,39}$/.test(kind.id)) throw new Error(`"${kind.id}" is not an edge kind.`);
    if (this.kinds.has(kind.id)) throw new Error(`Edge kind "${kind.id}" is already registered.`);
    if (!kind.label.trim() || !kind.about.trim()) throw new Error(`Edge kind "${kind.id}" needs a label and an about line.`);
    this.kinds.set(kind.id, kind);
    return this;
  }

  get(id: string): EdgeKind | undefined {
    return this.kinds.get(id);
  }

  /** How the runner reads an edge; a kind nobody registered is an input. */
  reads(id: string): EdgeReading {
    return this.kinds.get(id)?.reads ?? "input";
  }

  list(): EdgeKind[] {
    return [...this.kinds.values()];
  }
}

export function createDefaultEdgeKinds(): EdgeKindRegistry {
  return new EdgeKindRegistry()
    .register({
      id: "assumes",
      label: "Builds on",
      about: "May rely on what the earlier item made, without going over it again.",
      reads: "assumes",
    })
    .register({
      id: "fix_of",
      label: "Fixes",
      about: "Works on what was missed in the earlier item: reads what it made and the result recorded on it.",
      reads: "input",
    });
}
