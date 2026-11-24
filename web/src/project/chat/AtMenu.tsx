import type { FormatDescriptor } from "../../api/types";
import { FormatTile } from "../../design/FormatTile";
import { Icon } from "../../design/Icon";
import { detailOf, marked, MENTION_TABS, type MentionGroup, type Mentionable } from "../mentions";

/**
 * The list `@` opens: tabs for what to point at, then what matches the
 * words typed after the @, grouped, with the matched letters marked. What
 * is picked goes in the message as a chip; a source the chat does not read
 * says that picking it ticks it. On All, each group shows its best few, and
 * "N more" under one opens its own tab.
 */
export function AtMenu({
  found,
  more = [],
  query,
  tab,
  onTab,
  active,
  formats,
  onPick,
  onHover,
}: {
  found: Mentionable[];
  /** Groups with more than the list shows, and the tab that lists them all. */
  more?: Array<{ group: MentionGroup; count: number; tab: number }>;
  query: string;
  tab: number;
  onTab: (tab: number) => void;
  active: number;
  formats: readonly FormatDescriptor[];
  onPick: (m: Mentionable) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className="cpop at" role="listbox" aria-label="Mention">
      <div className="cpop-tabs" role="group" aria-label="Show">
        {MENTION_TABS.map((t, i) => (
          <button key={t.label} type="button" aria-pressed={i === tab} onMouseDown={(e) => e.preventDefault()} onClick={() => onTab(i)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="cpop-sc">
        {found.length === 0 && <p className="cpop-none">{query ? `Nothing in this project matches “${query}”.` : "Nothing here yet."}</p>}
        {found.map((m, i) => (
          <div key={m.key}>
            {(i === 0 || found[i - 1]!.group !== m.group) && (
              <div className="cpop-h" aria-hidden="true">
                {m.group}
              </div>
            )}
            <div role="option" aria-selected={i === active} className={`cpop-row${i === active ? " on" : ""}`} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => onHover(i)} onClick={() => onPick(m)}>
              {m.format ? (
                <FormatTile id={m.format} formats={formats} size="sm" />
              ) : (
                <span className="cpop-ic">
                  <Icon name={m.group === "Sources" ? "doc" : m.group === "Chats" ? "chat" : "list"} />
                </span>
              )}
              <span className="cpop-tx">
                <b>
                  {marked(m.name, query).map((p, k) => (p.hit ? <mark key={k}>{p.text}</mark> : p.text))}
                </b>
                {detailOf(m) && <small>{detailOf(m)}</small>}
              </span>
            </div>
            {found[i + 1]?.group !== m.group && <More of={more.find((x) => x.group === m.group)} onTab={onTab} />}
          </div>
        ))}
      </div>
      <div className="cpop-keys" aria-hidden="true">
        <span>↑ ↓ to move</span>
        <span>Enter to add</span>
        <span>Esc to close</span>
      </div>
    </div>
  );
}

/** "3 more chats" under a group the All tab cut short: opens the group's own tab. */
function More({ of, onTab }: { of: { group: MentionGroup; count: number; tab: number } | undefined; onTab: (tab: number) => void }) {
  if (!of) return null;
  return (
    <button type="button" className="cpop-more" onMouseDown={(e) => e.preventDefault()} onClick={() => onTab(of.tab)}>
      {of.count} more in {MENTION_TABS[of.tab]!.label}
    </button>
  );
}
