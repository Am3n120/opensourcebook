import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ChatCommand, FormatDescriptor } from "../../api/types";
import { Icon } from "../../design/Icon";
import { useNarrow } from "../../sources/useNarrow";
import { mentionAt, mentionList, splitMentions, type Mentionable } from "../mentions";
import type { RightView } from "../rightPanel";
import { AtMenu } from "./AtMenu";
import { bareCommand, matchCommands, pickedAlone } from "./commands";
import { SlashMenu } from "./SlashMenu";
import { helpLine } from "./words";

/**
 * The chat box: what the person types, with Tools (the same list as `/`),
 * the sources chip, who answers the chat, and the round send button; under
 * it one line on how to make something. Asking for a shape here never makes
 * it: a shape picked with nothing else typed opens its make sheet, and words
 * go to the chat, whose reply opens the sheet filled in.
 */
export function Composer({
  all,
  commands,
  formats,
  onSend,
  onOpen,
  onMention,
  disabled,
  archived,
  sourcesChip,
  picker,
  notice,
  fill,
  manySources,
}: {
  all: Mentionable[];
  commands: ChatCommand[];
  formats: readonly FormatDescriptor[];
  onSend: (text: string) => void;
  /** Opens a view in the right column: a shape's make sheet, or a new plan. */
  onOpen: (view: RightView) => void;
  /** Something was picked from the @ list. */
  onMention?: (m: Mentionable) => void;
  disabled: boolean;
  archived: boolean;
  sourcesChip?: ReactNode;
  picker?: ReactNode;
  /** Said above the box, such as that the agent can't be reached. */
  notice?: ReactNode;
  /** Words another part of the chat puts in the box, once per id. */
  fill?: { id: number; text: string };
  /** More than one source to ask about: the box says sources, not source. */
  manySources: boolean;
}) {
  const narrow = useNarrow();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [tools, setTools] = useState(false);
  const [atTab, setAtTab] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);

  // The box grows with what is typed, up to its cap, and shrinks again once sent.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const filled = useRef<number>(undefined);
  useEffect(() => {
    if (!fill || fill.id === filled.current) return;
    filled.current = fill.id;
    put(fill.text, fill.text.length);
  }, [fill]);

  // Esc closes the @ list for the word it was open on; typing opens it again.
  const [shut, setShut] = useState<number>();
  const typed = mentionAt(text, caret);
  const at = typed && typed.start !== shut ? typed : undefined;
  const { found, more } = at ? mentionList(all, at.query, atTab) : { found: [], more: [] };
  // A "/" at the start lists the engine's commands while the word is typed; Tools lists them all.
  const slash = caret > 0 ? /^\/(\S*)$/.exec(text.slice(0, caret))?.[1] : undefined;
  const offered = slash !== undefined ? matchCommands(commands, slash) : tools ? matchCommands(commands) : [];
  const listing = !at && (slash !== undefined ? offered.length > 0 : tools);
  const active = Math.min(pick, Math.max(0, (listing ? offered.length : found.length) - 1));

  function put(next: string, pos: number) {
    setText(next);
    setCaret(pos);
    setPick(0);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(pos, pos);
    });
  }

  /** A command picked: alone, a shape opens its sheet and a plan opens a new plan; otherwise it starts the message. */
  function command(c: ChatCommand) {
    const rest = (slash !== undefined ? text.slice(caret).replace(/^\S*/, "") : text.replace(/^\/\S*/, "")).trim();
    setTools(false);
    const alone = pickedAlone(c);
    if (!rest && alone !== "type") {
      put("", 0);
      onOpen(alone === "sheet" ? { kind: "make", shape: c.format! } : { kind: "planNew" });
      return;
    }
    complete(c);
  }

  /** The command's word put in the box, with what was typed after it kept. */
  function complete(c: ChatCommand) {
    const rest = (slash !== undefined ? text.slice(caret).replace(/^\S*/, "") : text.replace(/^\/\S*/, "")).trim();
    setTools(false);
    const next = `/${c.command} ${rest}`;
    put(next, rest ? next.length : c.command.length + 2);
  }

  function choose(m: Mentionable) {
    if (!at) return;
    const next = `${text.slice(0, at.start)}@${m.name} ${text.slice(caret)}`;
    put(next, at.start + m.name.length + 2);
    onMention?.(m);
  }

  function submit() {
    if (!text.trim() || disabled) return;
    const bare = bareCommand(text, commands);
    if (bare && pickedAlone(bare) !== "type") return command(bare);
    onSend(text);
    setText("");
    setCaret(0);
    setTools(false);
    area.current?.focus();
  }

  /** Closes the open list and keeps what was typed. */
  function close() {
    setTools(false);
    if (at) setShut(at.start);
    else setCaret(-1);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (listing && offered.length > 0) {
      if (e.key === "ArrowDown") return e.preventDefault(), setPick((active + 1) % offered.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setPick((active - 1 + offered.length) % offered.length);
      const chosen = offered[active]!;
      // Tab completes the word for more to be typed after it; Enter picks it, except a chat command typed in full, which it sends.
      if (e.key === "Tab") return e.preventDefault(), complete(chosen);
      const typedInFull = slash === chosen.command && pickedAlone(chosen) === "type";
      if (e.key === "Enter" && !e.shiftKey && !typedInFull) return e.preventDefault(), command(chosen);
    }
    if ((listing || at) && e.key === "Escape") return e.preventDefault(), close();
    if (at && found.length > 0) {
      if (e.key === "ArrowDown") return e.preventDefault(), setPick((active + 1) % found.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setPick((active - 1 + found.length) % found.length);
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), choose(found[active]!);
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const names = all.map((m) => m.name);
  const placeholder = archived ? "This project is archived" : narrow ? "Ask, or say what to make" : `Ask about your ${manySources ? "sources" : "source"}, or say what to make`;

  return (
    <div className="ccomposer">
      {notice}
      <div className="cbox">
        {listing && <SlashMenu list={offered} active={active} formats={formats} onPick={command} onHover={setPick} />}
        {at && <AtMenu found={found} more={more} query={at.query} tab={atTab} onTab={(t) => (setAtTab(t), setPick(0))} active={active} formats={formats} onPick={choose} onHover={setPick} />}
        <div className="cbox-text">
          <div className="cbox-mirror" ref={mirror} aria-hidden="true">
            {splitMentions(text, names).map((p, k) => (p.mention ? <span key={k} className="mchip">{p.text}</span> : p.text))}
            {"​"}
          </div>
          <textarea
            ref={area}
            rows={1}
            aria-label="Message"
            placeholder={placeholder}
            disabled={archived}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setPick(0);
              setShut(undefined);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onScroll={(e) => mirror.current && (mirror.current.scrollTop = e.currentTarget.scrollTop)}
            onKeyDown={onKey}
            onBlur={() => setTools(false)}
          />
        </div>
        <div className="cbox-row">
          {!archived && commands.length > 0 && (
            <button
              type="button"
              className={`ctools${listing && !slash ? " on" : ""}`}
              aria-label="Tools"
              aria-expanded={listing}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (listing) return close();
                if (!text.trim()) return put("/", 1);
                setTools(true);
                setPick(0);
                area.current?.focus();
              }}
            >
              <Icon name="sparkle" />
              <span>Tools</span>
            </button>
          )}
          {sourcesChip}
          <span className="sp" />
          {picker}
          <button className="csend" type="button" aria-label="Send" disabled={!text.trim() || disabled} onClick={submit}>
            <Icon name="arrow-up" />
          </button>
        </div>
      </div>
      {!archived && <p className="chelp">{helpLine(commands, formats)}</p>}
    </div>
  );
}
