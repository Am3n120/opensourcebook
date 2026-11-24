/**
 * The talk skill: a message about Open Sourcebook itself (what it is, what it can make)
 * or about what was just said in the chat, rather than a question about
 * the sources. It answers from what the chat knows about Open Sourcebook
 * (chat/about-opensourcebook.ts) and the conversation, with no cites, and never says
 * the sources are silent: they were not asked about.
 */
import { isRecord } from "../net";
import { describeOpenSourcebook } from "./about-opensourcebook";
import { renderHistory, renderMentions } from "./context";
import { say, type TextPiece } from "./pieces";
import type { ChatSkill } from "./skills";

export const TALK_SYSTEM_PROMPT = `You are Open Sourcebook, talking with a person in the chat of one of their projects. This message is about Open Sourcebook itself or about the conversation, not a question about what their sources say.
Answer from what you are told about Open Sourcebook, the project and the conversation. Do not cite sources, and do not say the sources do not cover it: this is not about the sources.
Be honest about what Open Sourcebook can do now. A format Open Sourcebook can't make yet is simply that: say "Open Sourcebook can't make <it> yet", with no words like declared, registry, built or available. Never offer one format as another, and never suggest the person turn what Open Sourcebook makes into a format it can't make themselves. If the person seems to want something from their sources, say that you can answer questions about them or make a plan.
Write in the language the person writes in. Be brief and direct.
Return only JSON: {"parts": [{"text": "<a sentence or a short paragraph>"}]}`;

const HISTORY_CHARS = 6_000;

export function createTalkSkill(): ChatSkill {
  return {
    id: "talk",
    label: "talk",
    about: "Talks about Open Sourcebook itself and about the conversation: what Open Sourcebook is, what it can make now, what was just said.",
    whenToUse:
      "the message is about Open Sourcebook itself (what it is, what it can make or do), about something said earlier in this chat, or is small talk or thanks, and it neither asks what the sources say nor is about a plan this chat made.",
    async run(turn) {
      const sources = turn.context.projectSources.map((source) => `- ${source.title} (${source.kind})`);
      const plans = await turn.services.repos.plans.listBySession(turn.chat.id);
      const prompt = [
        describeOpenSourcebook(turn.services.registry, turn.services.skills),
        sources.length ? `Sources in this project:\n${sources.join("\n")}` : "This project has no sources yet.",
        plans.length ? `Plans made in this chat, newest first:\n${plans.slice(0, 5).map((plan) => `- "${plan.title ?? "Untitled plan"}" (${plan.kickedOffAt ? "started" : plan.status})`).join("\n")}` : "",
        renderMentions(turn.context),
        turn.history.length ? `Conversation so far:\n${renderHistory(turn.history, HISTORY_CHARS)}` : "",
        `Message:\n${turn.text}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const raw = await turn.provider.generateJSON<unknown>({
        systemPrompt: TALK_SYSTEM_PROMPT,
        userPrompt: prompt,
        task: "chat",
      });
      const parts: TextPiece[] = (isRecord(raw) && Array.isArray(raw.parts) ? raw.parts : isRecord(raw) && typeof raw.text === "string" ? [{ text: raw.text }] : [])
        .flatMap((part) => (isRecord(part) && typeof part.text === "string" && part.text.trim() ? [say(part.text.trim())] : []));
      return { pieces: parts.length ? parts : [say("I'm not sure what to say to that. Ask me about your sources, or ask for a plan.")] };
    },
  };
}
