/**
 * Skills a chat can use besides answering (engine/docs/api.md). The chat
 * core knows only this interface:
 * it asks the registry which skills exist, lets the router pick one per turn
 * from what each says about itself, and runs it. Adding a skill is
 * registering one here; nothing in the chat core changes.
 */
import type { Cite } from "../cards/contract";
import type { ConditionRegistry } from "../studio/conditions";
import type { PlanRunner } from "../studio/plan-runner";
import type { FormatRegistry } from "../studio/registry";
import type { Message, Project, Session, StudioRepositories } from "../studio/repositories";
import type { StructuredProvider } from "../types/provider";
import type { TurnContext } from "./context";
import type { KnownSkill } from "./about-opensourcebook";
import type { ReplyPiece } from "./pieces";

/**
 * What a command does, which is how the `/` list and the Tools list group
 * it: `make` opens one thing's make sheet, `plan` opens a plan to look over
 * before Start, `chat` makes nothing and answers in the chat.
 */
export type CommandGroup = "make" | "plan" | "chat";

/** The order the groups are listed in. */
export const COMMAND_GROUPS: readonly CommandGroup[] = ["make", "plan", "chat"];

export interface ChatSkill {
  /** Stable id, stored on the replies it writes. Lower camelCase. */
  readonly id: string;
  /** The word on screen. */
  readonly label: string;
  /** The word after `/` that forces it, when it has one. */
  readonly command?: string;
  /** The one name of its command on screen everywhere (the `/` list, the Tools list, the Studio, the docs). A skill with a `command` must have it. */
  readonly title?: string;
  /** What its command does (see CommandGroup). A skill with a `command` must have it. */
  readonly group?: CommandGroup;
  /** Kept one release for older clients: the words on a button that starts its command. Use `title`. */
  readonly action?: string;
  /** It makes nothing, so it is offered only in the chat, never beside the formats in the Studio. Kept for older clients: it is `group: "chat"`. */
  readonly chatOnly?: boolean;
  /** What it does, for people (`GET /v1/skills`). */
  readonly about: string;
  /** When to use it, for the router that decides each turn. */
  readonly whenToUse: string;
  /**
   * When Open Sourcebook may offer it unasked, at the end of a plain answer, as a
   * question whose accepting option names this skill. No offer when absent.
   */
  readonly offerWhen?: string;
  /**
   * Commands it takes besides `command`, worked out from what is registered
   * now (one per ready format, say). Each forces this skill with `format` set.
   */
  commandsFor?(registry: FormatRegistry): SkillCommand[];
  run(turn: SkillTurn): Promise<SkillReply>;
}

/** A command a skill works out from the registries. */
export interface SkillCommand {
  /** The word after `/`. */
  word: string;
  /** The one name on screen everywhere. */
  title: string;
  /** What it does: make one thing, plan, or answer in the chat. */
  group: CommandGroup;
  /** Kept one release for older clients; use `title`. */
  label: string;
  /** Kept one release for older clients; use `title`. */
  action?: string;
  /** Offered only in the chat: it makes nothing (`group: "chat"`). */
  chatOnly?: boolean;
  /** One line on what it does, for people. */
  about: string;
  /** The format it makes, when it makes one. */
  format?: string;
}

/** A command as the chat offers it: a skill's own, or one it works out (`GET /v1/skills`, `commands`). */
export interface ChatCommand extends SkillCommand {
  skill: string;
}

/** Everything a skill may use for one turn. */
export interface SkillTurn {
  ownerId: string;
  project: Project;
  chat: Session;
  /** What was asked of the skill: the message, without its `/command`. */
  text: string;
  /**
   * How the skill was chosen: `command` when the person forced it (`/command`
   * or `skill` in the request), `picked` when they picked an option that
   * names it, `routed` when Open Sourcebook chose it.
   */
  how: "command" | "picked" | "routed";
  /** The format the command named, when the person typed a format's command (`/quiz ...`). */
  format?: string;
  /** Earlier messages of this chat, oldest first, without this one. */
  history: Message[];
  /** Where the person wrote from: the `opensourcebook` command in a terminal, when not the app (there is no sheet to press there). */
  from?: "terminal";
  /** Sources, mentions and their context, as the chat core resolved them. */
  context: TurnContext;
  provider: StructuredProvider;
  services: SkillServices;
}

export interface SkillServices {
  repos: StudioRepositories;
  /** Every registered skill as the chat describes it (chat/about-opensourcebook.ts). */
  skills: readonly KnownSkill[];
  registry: FormatRegistry;
  conditions: ConditionRegistry;
  plans?: PlanRunner;
}

export interface SkillReply {
  /** What the client draws, in order. */
  pieces: ReplyPiece[];
  cites?: Cite[];
  /** False when the sources did not hold what was asked. */
  covered?: boolean;
}

export class SkillRegistry {
  private readonly skills = new Map<string, ChatSkill>();
  private readonly words = new Map<string, string>();

  register(skill: ChatSkill): this {
    if (!/^[a-z][A-Za-z0-9]{0,39}$/.test(skill.id)) throw new Error(`"${skill.id}" is not a skill id.`);
    if (this.skills.has(skill.id)) throw new Error(`Skill "${skill.id}" is already registered.`);
    if (skill.command !== undefined) {
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(skill.command)) throw new Error(`"${skill.command}" is not a command word.`);
      if (this.words.has(skill.command)) throw new Error(`Command "/${skill.command}" is already taken.`);
      if (!skill.title?.trim()) throw new Error(`Skill "${skill.id}" has a command and needs a title.`);
      if (!skill.group || !COMMAND_GROUPS.includes(skill.group)) throw new Error(`Skill "${skill.id}" has a command and needs a group (${COMMAND_GROUPS.join(", ")}).`);
      this.words.set(skill.command, skill.id);
    }
    this.skills.set(skill.id, skill);
    return this;
  }

  get(id: string): ChatSkill | undefined {
    return this.skills.get(id);
  }

  byCommand(command: string): ChatSkill | undefined {
    const id = this.words.get(command.toLowerCase());
    return id === undefined ? undefined : this.skills.get(id);
  }

  list(): ChatSkill[] {
    return [...this.skills.values()];
  }

  /**
   * Every command the chat takes now: each skill's own word, and the ones
   * skills work out from the registry, listed by group (make, plan, chat)
   * and in registry order inside a group. A worked-out word that is taken
   * already, or a title another command has, is left out.
   */
  commands(registry?: FormatRegistry): ChatCommand[] {
    const out: ChatCommand[] = [];
    const taken = (word: string, title: string) => out.some((known) => known.word === word || known.title.toLowerCase() === title.toLowerCase());
    for (const skill of this.skills.values()) {
      if (!skill.command || !skill.title || !skill.group) continue;
      out.push({
        word: skill.command,
        title: skill.title,
        group: skill.group,
        label: skill.label,
        ...(skill.action ? { action: skill.action } : {}),
        ...(skill.chatOnly || skill.group === "chat" ? { chatOnly: true } : {}),
        about: skill.about,
        skill: skill.id,
      });
    }
    if (registry) {
      for (const skill of this.skills.values()) {
        for (const command of skill.commandsFor?.(registry) ?? []) {
          const word = command.word.toLowerCase();
          const title = command.title.trim();
          if (!/^[a-z][a-z0-9-]{0,30}$/.test(word) || !title || !COMMAND_GROUPS.includes(command.group) || taken(word, title)) continue;
          out.push({ ...command, word, title, ...(command.group === "chat" ? { chatOnly: true } : {}), skill: skill.id });
        }
      }
    }
    return COMMAND_GROUPS.flatMap((group) => out.filter((command) => command.group === group));
  }

  /**
   * The skill a message's leading `/word` forces, the rest of the text, and
   * the format the word names when it is a format's command. Undefined when
   * the message does not start with a command the chat takes.
   */
  commandIn(text: string, registry?: FormatRegistry): { skill: ChatSkill; rest: string; command: ChatCommand } | undefined {
    const match = /^\/([a-z][a-z0-9-]*)(?:\s+|$)([\s\S]*)$/i.exec(text.trim());
    if (!match) return undefined;
    const command = this.commands(registry).find((known) => known.word === match[1].toLowerCase());
    const skill = command ? this.skills.get(command.skill) : undefined;
    return skill && command ? { skill, rest: match[2].trim(), command } : undefined;
  }
}
