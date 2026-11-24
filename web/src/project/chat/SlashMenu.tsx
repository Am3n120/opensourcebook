import { Fragment } from "react";
import { Link } from "react-router";
import type { ChatCommand, FormatDescriptor } from "../../api/types";
import { FormatTile } from "../../design/FormatTile";
import { findFormat } from "../../design/formatLook";
import { Icon } from "../../design/Icon";
import { COMMAND_GROUPS, firstSentence } from "./commands";

/**
 * The list `/` and the Tools button open: the shapes and skills the engine
 * lists, grouped by what picking one does, each with its own title and line
 * from its registry entry (the first sentence, whole, on up to two lines)
 * and the word to type. A shape that can't be made
 * now says why in its own words, and a spoken one points at the voice.
 */
export function SlashMenu({ list, active, formats, onPick, onHover }: { list: ChatCommand[]; active: number; formats: readonly FormatDescriptor[]; onPick: (c: ChatCommand) => void; onHover: (index: number) => void }) {
  return (
    <div className="cpop slash" role="listbox" aria-label="Commands">
      <div className="cpop-sc">
        {list.length === 0 && <p className="cpop-none">Nothing to pick matches that.</p>}
        {list.map((c, i) => {
          const group = COMMAND_GROUPS.find((g) => g.id === c.group);
          const head = group && (i === 0 || list[i - 1]!.group !== c.group);
          const format = c.format ? findFormat(formats, c.format) : undefined;
          const blocked = format !== undefined && !format.ready;
          return (
            <Fragment key={c.command}>
              {head && (
                <div className={`cpop-h${i > 0 ? " sep" : ""}`} aria-hidden="true">
                  {group.title} · {group.note}
                </div>
              )}
              <div
                role="option"
                aria-selected={i === active}
                aria-label={`${c.title}, /${c.command}`}
                className={`cpop-row${i === active ? " on" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(c)}
              >
                {c.format ? (
                  <FormatTile id={c.format} formats={formats} size="sm" />
                ) : (
                  <span className="cpop-ic">
                    <Icon name={c.group === "plan" ? "list" : "sparkle"} />
                  </span>
                )}
                <span className="cpop-tx">
                  <b>{c.title}</b>
                  <small className={`cpop-about${blocked ? " warn" : ""}`}>
                    {firstSentence(c.about)}
                    {blocked && format.voiced && (
                      <>
                        {" · "}
                        <Link to="/settings#voice" onClick={(e) => e.stopPropagation()}>
                          Set up voice
                        </Link>
                      </>
                    )}
                  </small>
                </span>
                <code className="cpop-cmd">/{c.command}</code>
              </div>
            </Fragment>
          );
        })}
      </div>
      <div className="cpop-keys" aria-hidden="true">
        <span>↑ ↓ to move</span>
        <span>Enter to pick</span>
        <span>Type to filter</span>
        <span>Esc to close</span>
      </div>
    </div>
  );
}
