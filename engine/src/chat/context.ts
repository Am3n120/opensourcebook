/**
 * What one chat turn reads (engine/docs/api.md, "Which sources a reply
 * reads"): the sources in scope with their stored passages, and what the
 * message @-mentioned. Mentions of things outside the chat's project, or
 * that do not exist, are ignored; a kind nothing here reads is stored with
 * the message and ignored too.
 */
import type { Message, Mention, Plan, PlanNode, Project, Session, Source, StudioRepositories } from "../studio/repositories";
import type { NodeSource, SourceLocator } from "../studio/types";

/** A source as a turn reads it: its ready extraction, maybe narrowed to a range. */
export interface TurnSource extends NodeSource {
  kind: string;
}

export interface TurnContext {
  /** Sources the reply may read, in project order. */
  sources: TurnSource[];
  /** Why these: what the message mentioned, what was ticked, or the whole project. */
  scope: "mentioned" | "ticked" | "all";
  /** Sources in scope whose extraction is not ready, so the reply cannot read them. */
  unread: Array<{ sourceId: string; title: string }>;
  /** Every source of the project, ready or not (the planner may name any of them). */
  projectSources: Source[];
  plans: Plan[];
  items: PlanNode[];
  chats: Array<{ chat: Session; messages: Message[] }>;
}

export interface TurnRequest {
  mentions: Mention[];
  /** Ticked for this turn; undefined when the client sent none. */
  sources?: string[];
}

/** Messages of a mentioned chat the turn reads. */
const MENTIONED_CHAT_MESSAGES = 20;

export async function buildTurnContext(repos: StudioRepositories, project: Project, chat: Session, request: TurnRequest): Promise<TurnContext> {
  const projectSources = await repos.sources.listByProject(project.id);
  const inProject = new Map(projectSources.map((source) => [source.id, source]));

  const plans: Plan[] = [];
  const items: PlanNode[] = [];
  const chats: TurnContext["chats"] = [];
  const mentioned = new Map<string, SourceLocator | undefined>();
  for (const mention of request.mentions) {
    if (mention.kind === "source" && inProject.has(mention.id)) mentioned.set(mention.id, undefined);
    if (mention.kind === "plan") {
      const plan = await repos.plans.get(mention.id);
      if (plan && plan.projectId === project.id && !plans.some((known) => known.id === plan.id)) plans.push(plan);
    }
    if (mention.kind === "item") {
      const node = await repos.plans.getNode(mention.id);
      const plan = node ? await repos.plans.get(node.planId) : undefined;
      if (!node || plan?.projectId !== project.id) continue;
      items.push(node);
      for (const use of await repos.plans.listNodeSources(node.id)) {
        // The whole source wins over a range when both are mentioned.
        if (inProject.has(use.sourceId) && !(mentioned.has(use.sourceId) && mentioned.get(use.sourceId) === undefined)) mentioned.set(use.sourceId, use.range);
      }
    }
    if (mention.kind === "chat" && mention.id !== chat.id) {
      const other = await repos.sessions.get(mention.id);
      if (other?.projectId === project.id) chats.push({ chat: other, messages: await repos.sessions.recentMessages(other.id, MENTIONED_CHAT_MESSAGES) });
    }
  }

  const ticked = request.sources ?? stringList(chat.settings.sources);
  let scope: TurnContext["scope"] = "all";
  let chosen: Array<{ source: Source; range?: SourceLocator }> = projectSources.map((source) => ({ source }));
  if (mentioned.size > 0) {
    scope = "mentioned";
    chosen = projectSources.filter((source) => mentioned.has(source.id)).map((source) => ({ source, range: mentioned.get(source.id) }));
  } else if (ticked) {
    scope = "ticked";
    const set = new Set(ticked);
    chosen = projectSources.filter((source) => set.has(source.id)).map((source) => ({ source }));
  }

  const sources: TurnSource[] = [];
  const unread: TurnContext["unread"] = [];
  for (const { source, range } of chosen) {
    const extraction = await repos.sources.getExtraction(source.contentHash);
    if (extraction?.status !== "ready" || !extraction.envelope) {
      unread.push({ sourceId: source.id, title: source.title });
      continue;
    }
    sources.push({
      sourceId: source.id,
      kind: source.kind,
      title: source.title,
      envelope: extraction.envelope,
      chunks: await repos.sources.listChunks(source.contentHash),
      ...(range ? { range } : {}),
    });
  }
  return { sources, scope, unread, projectSources, plans, items, chats };
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

/** The text of a stored message, whatever its role. */
export function messageText(message: Message): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content) && typeof content.text === "string") return content.text;
  return "";
}

/** Recent turns as a transcript for a prompt, newest last, within `maxChars`. */
export function renderHistory(history: Message[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of [...history].reverse()) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content;
    const picked = message.role === "user" && content && typeof content === "object" && !Array.isArray(content) && content.answer !== undefined;
    // A message in a thread on a made thing says which thing and where in it.
    const about = content && typeof content === "object" && !Array.isArray(content) && content.about && typeof content.about === "object" && !Array.isArray(content.about) ? content.about : undefined;
    const on = message.role === "user" && about && typeof about.title === "string" ? ` (in the thread on "${about.title}"${typeof about.label === "string" ? `, ${about.label}` : ""})` : "";
    const line = `${message.role === "user" ? (picked ? "Person (picked)" : "Person") : "Open Sourcebook"}${on}: ${messageText(message).trim()}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join("\n");
}

/** What the message mentioned besides sources, for a prompt. Empty when nothing. */
export function renderMentions(context: TurnContext): string {
  const parts: string[] = [];
  for (const plan of context.plans) parts.push(`Plan mentioned: "${plan.title ?? "Untitled plan"}" (${plan.status}).`);
  for (const item of context.items) parts.push(`Plan item mentioned: "${item.title}" (${item.type}). Brief: ${item.prompt || "none"}`);
  for (const { chat, messages } of context.chats) {
    parts.push(`Earlier chat mentioned: "${chat.title ?? "Untitled chat"}"\n${renderHistory(messages, 6_000)}`);
  }
  return parts.join("\n\n");
}
