/**
 * A project as one file, and back: its sources as the text that was read
 * from them, its chats, and its plans with what they made. Used to keep a
 * finished project as an example (`examples/<name>/project.json`) and to
 * open one in another engine.
 *
 * Nothing is taken on trust when a bundle comes in. Every cite is looked up
 * again, word for word, in the sources the bundle brings, and one whose
 * quote is not there is dropped. Made things that point at files the
 * bundle does not carry (a video's file) are left out.
 */
import { isDay } from "./days";
import { quoteInPassage } from "../sources/passages";
import { isFormatId, type Citation, type JsonValue, type SourceChunk } from "./types";
import type { StudioRepositories } from "./repositories";
import type { Mention } from "./repositories/sessions";
import { NODE_STATUSES, PLAN_STATUSES, type NodeStatus, type PlanStatus } from "./repositories/plans";

export const BUNDLE_VERSION = 1;

export interface BundleSource {
  /** How chats, items and made things in the bundle name this source. */
  key: string;
  kind: string;
  title?: string;
  text: string;
}

/** A cite inside a bundle: a source by its key and the words it quotes. */
export interface BundleCite {
  source: string;
  quote?: string;
  anchor?: string;
}

export interface BundleMessage {
  role: "user" | "assistant";
  /** The message as the chat route shows it, its cites written as `BundleCite`s. */
  content: { [key: string]: JsonValue };
  mentions?: Mention[];
}

export interface BundleChat {
  key: string;
  title?: string;
  messages: BundleMessage[];
}

export interface BundleOutput {
  type: string;
  schemaVersion: number;
  title: string;
  summary?: string;
  payload: JsonValue;
  citations?: BundleCite[];
  sources?: string[];
}

export interface BundleItem {
  key: string;
  parent?: string;
  level: number;
  ord: number;
  type: string;
  title: string;
  prompt?: string;
  settings?: { [key: string]: JsonValue };
  enabled?: boolean;
  status: string;
  sources?: string[];
  output?: BundleOutput;
}

export interface BundlePlan {
  key: string;
  /** The chat that made it, by key. */
  chat?: string;
  title?: string;
  status: string;
  stages?: Array<{ level: number; label: string }>;
  /** The days stages are meant for (migrations/0017), YYYY-MM-DD. */
  days?: Array<{ level: number; dueOn: string }>;
  items: BundleItem[];
}

export interface ProjectBundle {
  /** What marks a file as an exported project. Files written before the rename say `re` here (`OLD_BUNDLE_MARK`); both are read. */
  opensourcebook: "project";
  version: number;
  project: { title: string };
  sources: BundleSource[];
  chats: BundleChat[];
  plans?: BundlePlan[];
}

export class BundleError extends Error {}

/** Payload text that points at a stored file this engine serves: such a file is not in the bundle. */
const STORED_FILE = /\/v1\/assets\//;

// ---------------------------------------------------------------- export

export async function exportProject(repos: StudioRepositories, projectId: string): Promise<ProjectBundle> {
  const project = await repos.projects.get(projectId);
  if (!project) throw new BundleError("Project not found");

  const sources: BundleSource[] = [];
  const sourceKey = new Map<string, string>();
  const chunkText = new Map<string, string>();
  for (const source of await repos.sources.listByProject(projectId)) {
    const extraction = await repos.sources.getExtraction(source.contentHash);
    const text = extraction?.envelope?.text;
    if (!text?.trim()) continue;
    const key = `s${sources.length + 1}`;
    sourceKey.set(source.id, key);
    sources.push({ key, kind: "text", title: source.title, text });
    for (const chunk of await repos.sources.listChunks(source.contentHash)) chunkText.set(chunk.id, chunk.text);
  }
  const cite = (c: Citation): BundleCite | undefined => {
    const key = sourceKey.get(c.sourceId);
    if (!key) return undefined;
    return { source: key, ...(c.quote ? { quote: c.quote } : {}), ...(c.anchor ? { anchor: c.anchor } : {}) };
  };

  const plans = (await repos.plans.listByProject(projectId)).filter((plan) => plan.status !== "discarded");
  const planKey = new Map(plans.map((plan, i) => [plan.id, `p${i + 1}`]));

  const chats: BundleChat[] = [];
  const chatKey = new Map<string, string>();
  for (const chat of await repos.sessions.listByProject(projectId)) {
    const key = `c${chats.length + 1}`;
    chatKey.set(chat.id, key);
    const messages: BundleMessage[] = [];
    for (const message of await repos.sessions.listMessages(chat.id)) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const content: { [key: string]: JsonValue } = isRecord(message.content) ? { ...message.content } : { text: String(message.content ?? "") };
      // A reply still being written, or one that stopped, is not kept.
      if (message.role === "assistant" && content.state !== undefined && content.state !== "done") continue;
      for (const field of ["state", "agent", "steps", "sources", "answer"]) delete content[field];
      if (Array.isArray(content.cites)) content.cites = (content.cites as unknown as Citation[]).map((c) => cite(c) ?? null) as unknown as JsonValue;
      if (Array.isArray(content.pieces)) content.pieces = keepPlanPieces(content.pieces as JsonValue[], planKey);
      // Mentions name rows by id, which mean nothing in another engine; the words of the message stay.
      messages.push({ role: message.role, content });
    }
    chats.push({ key, ...(chat.title ? { title: chat.title } : {}), messages });
  }

  const bundlePlans: BundlePlan[] = [];
  for (const plan of plans) {
    const nodes = await repos.plans.listNodes(plan.id);
    const itemKey = new Map(nodes.map((node, i) => [node.id, `i${i + 1}`]));
    const items: BundleItem[] = [];
    for (const node of nodes) {
      const used = (await repos.plans.listNodeSources(node.id)).flatMap((s) => sourceKey.get(s.sourceId) ?? []);
      const made = await repos.outputs.latestForNode(node.id);
      const output: BundleOutput | undefined =
        made && !STORED_FILE.test(JSON.stringify(made.payload))
          ? {
              type: made.type,
              schemaVersion: made.schemaVersion,
              title: made.title,
              ...(made.summary ? { summary: made.summary } : {}),
              payload: made.payload,
              citations: made.citations.flatMap((c) => cite(c) ?? []),
              sources: made.sources.flatMap((s) => sourceKey.get(s.sourceId) ?? []),
            }
          : undefined;
      items.push({
        key: itemKey.get(node.id)!,
        ...(node.parentId && itemKey.has(node.parentId) ? { parent: itemKey.get(node.parentId)! } : {}),
        level: node.level,
        ord: node.ord,
        type: node.type,
        title: node.title,
        ...(node.prompt ? { prompt: node.prompt } : {}),
        ...(Object.keys(node.settings).length ? { settings: node.settings } : {}),
        ...(node.enabled ? {} : { enabled: false }),
        // A thing whose made file is not carried goes back to waiting to be made.
        status: node.status === "done" && !output ? "pending" : node.status,
        ...(used.length ? { sources: used } : {}),
        ...(output ? { output } : {}),
      });
    }
    bundlePlans.push({
      key: planKey.get(plan.id)!,
      ...(plan.sessionId && chatKey.has(plan.sessionId) ? { chat: chatKey.get(plan.sessionId)! } : {}),
      ...(plan.title ? { title: plan.title } : {}),
      status: plan.status,
      stages: (await repos.plans.listStages(plan.id)).map(({ level, label }) => ({ level, label })),
      days: (await repos.plans.listStageDates(plan.id)).map(({ level, dueOn }) => ({ level, dueOn })),
      items,
    });
  }

  return { [BUNDLE_MARK]: "project", version: BUNDLE_VERSION, project: { title: project.title }, sources, chats, ...(bundlePlans.length ? { plans: bundlePlans } : {}) };
}

/** Plan pieces keep their plan by key; a piece about a plan not carried is dropped. */
function keepPlanPieces(pieces: JsonValue[], planKey: Map<string, string>): JsonValue[] {
  return pieces.flatMap((piece) => {
    if (!isRecord(piece) || piece.kind !== "plan") return [piece];
    const key = typeof piece.planId === "string" ? planKey.get(piece.planId) : undefined;
    return key ? [{ ...piece, planId: key }] : [];
  });
}

// ---------------------------------------------------------------- import

export interface ImportedProject {
  projectId: string;
  /** Cites that were dropped because their words are not in the source they name. */
  droppedCites: number;
  /** Made things left out because they point at files the bundle does not carry. */
  droppedOutputs: number;
}

/** Adds a source's text the way a pasted source is added; answers its new id. */
export type AddText = (input: { projectId: string; text: string; title?: string }) => Promise<{ id: string; contentHash: string }>;

export async function importProject(
  repos: StudioRepositories,
  input: { ownerId: string; bundle: unknown; settings?: { [key: string]: JsonValue }; addText: AddText },
): Promise<ImportedProject> {
  const bundle = readBundle(input.bundle);
  const project = await repos.projects.create({ ownerId: input.ownerId, title: bundle.project.title, ...(input.settings ? { settings: input.settings } : {}) });

  const sources = new Map<string, { id: string; chunks: SourceChunk[] }>();
  for (const source of bundle.sources) {
    const added = await input.addText({ projectId: project.id, text: source.text, ...(source.title ? { title: source.title } : {}) });
    sources.set(source.key, { id: added.id, chunks: await repos.sources.listChunks(added.contentHash) });
  }
  let droppedCites = 0;
  let droppedOutputs = 0;
  /** A bundle cite as a stored one, found again word for word; undefined when its words are not there. */
  const cite = (c: unknown): (Citation & { spot: string }) | undefined => {
    if (!isRecord(c) || typeof c.source !== "string") return undefined;
    const source = sources.get(c.source);
    if (!source) return undefined;
    const quote = typeof c.quote === "string" && c.quote.trim() ? c.quote.trim() : undefined;
    const chunk = quote ? source.chunks.find((ch) => quoteInPassage(quote, { id: ch.id, label: "", sourceId: source.id, text: ch.text })) : source.chunks[0];
    if (!chunk) return undefined;
    const locator = chunk.locator;
    return {
      sourceId: source.id,
      // The same kinds of spot a reply's cite carries (chat/blocks.ts).
      spot: locator?.cell ? "cell" : locator?.startMs !== undefined ? "moment" : "passage",
      chunkId: chunk.id,
      ...(locator && Object.keys(locator).length ? { locator } : {}),
      ...(quote ? { quote } : {}),
      ...(typeof c.anchor === "string" ? { anchor: c.anchor } : {}),
    };
  };

  const chats = new Map<string, string>();
  const pendingPlanPieces: Array<{ messageId: string; content: { [key: string]: JsonValue } }> = [];
  for (const chat of bundle.chats) {
    const session = await repos.sessions.create({ ownerId: input.ownerId, projectId: project.id, ...(chat.title ? { title: chat.title } : {}) });
    chats.set(chat.key, session.id);
    for (const message of chat.messages) {
      const content = { ...message.content };
      let citations: Citation[] | undefined;
      if (Array.isArray(content.cites)) {
        const found = (content.cites as unknown[]).map((c) => cite(c));
        droppedCites += found.filter((c) => !c).length;
        citations = found.filter((c): c is NonNullable<typeof c> => Boolean(c));
        content.cites = renumberCites(content, found);
      }
      const stored = await repos.sessions.append(session.id, {
        role: message.role,
        content,
        ...(message.mentions?.length ? { mentions: message.mentions } : {}),
        ...(citations?.length ? { citations } : {}),
      });
      if (Array.isArray(content.pieces) && content.pieces.some((p) => isRecord(p) && p.kind === "plan")) pendingPlanPieces.push({ messageId: stored.id, content });
    }
  }

  const plans = new Map<string, string>();
  for (const plan of bundle.plans ?? []) {
    const chatId = plan.chat ? chats.get(plan.chat) : undefined;
    const made = await repos.plans.create({ ownerId: input.ownerId, projectId: project.id, ...(chatId ? { sessionId: chatId } : {}), ...(plan.title ? { title: plan.title } : {}) });
    plans.set(plan.key, made.id);
    for (const stage of plan.stages ?? []) await repos.plans.setStageLabel(made.id, stage.level, stage.label);
    for (const day of plan.days ?? []) if (isDay(day.dueOn)) await repos.plans.setStageDate(made.id, day.level, day.dueOn);
    const items = new Map<string, string>();
    for (const item of plan.items) {
      const parentId = item.parent ? items.get(item.parent) : undefined;
      const node = await repos.plans.addNode({
        planId: made.id,
        ...(parentId ? { parentId } : {}),
        level: item.level,
        ord: item.ord,
        type: item.type,
        title: item.title,
        ...(item.prompt ? { prompt: item.prompt } : {}),
        ...(item.settings ? { settings: item.settings } : {}),
        ...(item.enabled === false ? { enabled: false } : {}),
      });
      items.set(item.key, node.id);
      const used = (item.sources ?? []).flatMap((key) => (sources.has(key) ? [{ sourceId: sources.get(key)!.id }] : []));
      if (used.length) await repos.plans.setNodeSources(node.id, used);
      let status = asNodeStatus(item.status);
      if (item.output) {
        const output = item.output;
        if (STORED_FILE.test(JSON.stringify(output.payload)) || !isFormatId(output.type)) {
          droppedOutputs += 1;
          status = "pending";
        } else {
          const citations = (output.citations ?? []).map((c) => cite(c));
          droppedCites += citations.filter((c) => !c).length;
          await repos.outputs.create({
            ownerId: input.ownerId,
            projectId: project.id,
            nodeId: node.id,
            type: output.type,
            schemaVersion: output.schemaVersion,
            title: output.title,
            ...(output.summary ? { summary: output.summary } : {}),
            payload: output.payload,
            citations: citations.filter((c): c is NonNullable<typeof c> => Boolean(c)),
            sources: (output.sources ?? []).flatMap((key) => (sources.has(key) ? [{ sourceId: sources.get(key)!.id }] : [])),
          });
        }
      } else if (status === "done") status = "pending";
      // Work that was under way when the bundle was made is not under way here.
      if (status === "running" || status === "queued") status = "cancelled";
      if (status !== "pending") await repos.plans.updateNode(node.id, { status });
    }
    const status = asPlanStatus(plan.status);
    if (status !== "draft") {
      // Started plans are marked started; one still running when kept is stopped here, and can be resumed.
      await repos.plans.setStatus(made.id, "running");
      if (status !== "running") await repos.plans.setStatus(made.id, status === "approved" ? "cancelled" : status);
      else await repos.plans.setStatus(made.id, "cancelled");
    }
  }

  for (const { messageId, content } of pendingPlanPieces) {
    const pieces = (content.pieces as JsonValue[]).flatMap((piece) => {
      if (!isRecord(piece) || piece.kind !== "plan") return [piece];
      const id = typeof piece.planId === "string" ? plans.get(piece.planId) : undefined;
      return id ? [{ ...piece, planId: id }] : [];
    });
    await repos.sessions.updateContent(messageId, { ...content, pieces });
  }
  // A plan piece whose plan is not in the bundle was already dropped on the way out; one in a chat with no plans goes here too.
  return { projectId: project.id, droppedCites, droppedOutputs };
}

/**
 * The message's cites without the ones not found, and every piece's cite
 * numbers moved to match. A piece's cite that pointed at a dropped one goes.
 */
function renumberCites(content: { [key: string]: JsonValue }, found: Array<Citation | undefined>): JsonValue {
  const newIndex = new Map<number, number>();
  const kept: JsonValue[] = [];
  found.forEach((c, i) => {
    if (!c) return;
    newIndex.set(i, kept.length);
    kept.push(c as unknown as JsonValue);
  });
  const fix = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(fix);
    if (!isRecord(value)) return value;
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === "cites" && Array.isArray(v) ? v.flatMap((n) => (typeof n === "number" && newIndex.has(n) ? [newIndex.get(n)!] : [])) : fix(v);
    }
    return out;
  };
  if (Array.isArray(content.pieces)) content.pieces = fix(content.pieces);
  return kept;
}

/** The key whose value "project" marks an exported project, and the one files exported before the rename carry. */
const BUNDLE_MARK = "opensourcebook";
const OLD_BUNDLE_MARK = "re";

function readBundle(value: unknown): ProjectBundle {
  if (!isRecord(value) || (value[BUNDLE_MARK] !== "project" && value[OLD_BUNDLE_MARK] !== "project")) throw new BundleError("Not an Open Sourcebook project bundle");
  if (value.version !== BUNDLE_VERSION) throw new BundleError(`This engine reads bundle version ${BUNDLE_VERSION}`);
  const project = value.project;
  if (!isRecord(project) || typeof project.title !== "string" || !project.title.trim()) throw new BundleError("The bundle's project needs a title");
  const sources = Array.isArray(value.sources) ? value.sources : [];
  for (const s of sources) {
    if (!isRecord(s) || typeof s.key !== "string" || typeof s.text !== "string" || !s.text.trim()) throw new BundleError("Every source needs a key and its text");
  }
  const chats = Array.isArray(value.chats) ? value.chats : [];
  for (const c of chats) {
    if (!isRecord(c) || typeof c.key !== "string" || !Array.isArray(c.messages)) throw new BundleError("Every chat needs a key and its messages");
    for (const m of c.messages) {
      if (!isRecord(m) || (m.role !== "user" && m.role !== "assistant") || !isRecord(m.content)) throw new BundleError("Every message needs a role and its content");
    }
  }
  const plans = Array.isArray(value.plans) ? value.plans : [];
  for (const p of plans) {
    if (!isRecord(p) || typeof p.key !== "string" || !Array.isArray(p.items)) throw new BundleError("Every plan needs a key and its items");
    for (const i of p.items) {
      if (!isRecord(i) || typeof i.key !== "string" || typeof i.type !== "string" || typeof i.title !== "string" || typeof i.level !== "number" || typeof i.ord !== "number") {
        throw new BundleError("Every item needs a key, a type, a title, a level and a place");
      }
    }
  }
  return { ...(value as unknown as ProjectBundle), project: { title: project.title.trim().slice(0, 200) } };
}

function asNodeStatus(value: string): NodeStatus {
  return (NODE_STATUSES as readonly string[]).includes(value) ? (value as NodeStatus) : "pending";
}
function asPlanStatus(value: string): PlanStatus {
  return (PLAN_STATUSES as readonly string[]).includes(value) && value !== "discarded" ? (value as PlanStatus) : "draft";
}

function isRecord(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
