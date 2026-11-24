/**
 * The tools the person's own agent works with in Open Sourcebook's chat (engine/docs/api.md,
 * "Your agent"). Each tool is defined once here: its name, what it does in
 * plain words for the agent, the JSON Schema of its input, the label a
 * person sees while it runs ("Searching Lecture 7"), and its handler. The
 * connector on the person's computer serves whatever this registry lists;
 * it knows no tool by name. A new tool is one registration.
 *
 * Every handler acts in Open Sourcebook for one turn only: the chat, its project and the
 * sources ticked in it. What a tool adds to the reply (a plan card, a
 * question, the reply's text) is its step's `result`, assembled into the
 * reply's pieces when the turn ends (turn.ts).
 */
import type { Cite } from "../../cards/contract";
import type { Passage } from "../../sources/passages";
import type { AgentStep, AgentTurn, Mention, Project, Session, Source } from "../../studio/repositories";
import type { JsonValue } from "../../studio/types";
import type { EngineDeps } from "../../wiring";
import type { OtherPiece } from "../pieces";
import type { ThreadAbout } from "../threads";
import type { MappedSource, SourceMap } from "../planning/sources";

/** A JSON Schema object, as the agent's tool list carries it. */
export type JsonSchema = { [key: string]: JsonValue };

/** The message the turn answers, as the person sent it. */
export interface AgentRequest {
  text: string;
  mentions: Mention[];
  /** The `/command` the message started with, and what that skill does. */
  command?: { word: string; about: string; format?: string };
  /** The item open in front of the person as they wrote, when the app says. */
  opened?: string;
  /** The person's day, YYYY-MM-DD, when the app says: for turning "by Friday" into a stage's day. */
  today?: string;
  /** True when the message picks options in Open Sourcebook's last questions. */
  picked?: boolean;
  /** Where the person is: the `opensourcebook` command in a terminal, not the app (absent: the app). */
  from?: "terminal";
  /** Written in the thread on a made thing: what it is about, and the facts of the spot they are at (chat/threads.ts). */
  thread?: { about: ThreadAbout; facts: string };
}

/** The sources of one turn: every readable source under a label that stays put, and which are ticked. */
export interface TurnSources {
  /** Readable sources of the project in project order: S1, S2, ... */
  map: SourceMap;
  /** Ids of the sources the chat may read: the ticked ones. */
  ticked: ReadonlySet<string>;
  /** Sources still being read, or that failed: not in `map`. */
  unread: Array<{ sourceId: string; title: string }>;
  projectSources: Source[];
  inScope(entry: MappedSource): boolean;
  /** Passages of the ticked sources, labelled `S1#4` (source, then passage number from 1). */
  passages(): Passage[];
}

/** Everything a tool may use for one call. */
export interface ToolTurn {
  turn: AgentTurn;
  project: Project;
  /** The chat as it is now (a tool may have ticked a source). */
  chat: Session;
  request: AgentRequest;
  deps: EngineDeps;
  /** Steps taken before this call, in order. */
  steps: AgentStep[];
  sources(): Promise<TurnSources>;
}

/**
 * What a step adds to the reply. `final` marks the reply's own words: the
 * reply tool may be called several times, each call adding its blocks
 * (`pieces`) after the ones before, and `more` says another call follows.
 * `cites` are every cite the reply uses so far (each call keeps the ones
 * before it at their indexes), `after` closes the reply. Other steps add
 * `pieces` (a plan card, a question) in the order they ran.
 */
export interface StepResult {
  pieces?: OtherPiece[];
  final?: boolean;
  /** The reply goes on in a later call of the reply tool. */
  more?: boolean;
  /** The reply read the sources and cites none of them: every block shows as not checked. */
  uncited?: boolean;
  after?: OtherPiece[];
  cites?: Cite[];
  covered?: boolean;
  /** What the step did, for the steps list once the turn ends (AgentTool.said). */
  note?: StepNote;
}

/**
 * What one step did, kept so the steps list can say it in the past and in
 * fewer lines: steps in a row of one tool with the same `group` are one
 * line ("Read 9 passages of Lecture 7").
 */
export interface StepNote {
  group?: string;
  [field: string]: JsonValue | undefined;
}

export interface ToolOutcome {
  /** What the agent reads back. */
  text: string;
  /** The call did nothing; `text` says why and how to call it again. */
  isError?: boolean;
  result?: StepResult;
  /** What the call did, for the steps list; kept even when it did nothing. */
  note?: StepNote;
}

export interface AgentTool {
  /** Lower snake_case; the agent sees it as is. */
  readonly name: string;
  /** What it does and when to use it, for the agent. */
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** What the person sees while it runs, in plain words. */
  label(input: Record<string, unknown>, turn: ToolTurn): Promise<string> | string;
  run(input: Record<string, unknown>, turn: ToolTurn): Promise<ToolOutcome>;
  /**
   * Steps of this tool in a row with the same note group, said once in the
   * past ("Read 9 passages of Lecture 7"). Without it the steps list shows
   * the label the person saw while it ran.
   */
  said?(steps: Array<{ note: StepNote; failed: boolean; label: string }>): string;
  /**
   * What a call shows while the agent is still writing it, from its input
   * so far (unfinished, closed where it was cut off). A tool with this is
   * named to the connector, which sends its input as it is written. Nothing
   * it returns is kept once the call itself arrives.
   */
  draft?(input: Record<string, unknown>, turn: ToolTurn): Promise<StepResult | undefined>;
}

/** A tool as the connector lists it to the agent. */
export interface ToolListing {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): this {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(tool.name)) throw new Error(`"${tool.name}" is not a tool name.`);
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered.`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  listing(): ToolListing[] {
    return this.list().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  }
}
