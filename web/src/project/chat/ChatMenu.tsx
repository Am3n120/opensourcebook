import { useState } from "react";
import type { Chat } from "../../api/types";
import { Icon } from "../../design/Icon";
import { useDismiss } from "../../design/useDismiss";
import { ago } from "./words";

/**
 * The chat's title, which opens the project's chats: each by its name and
 * how long ago it was last used, the open one first in weight, then New
 * chat, and for a saved chat Rename this chat and Delete this chat.
 */
export function ChatMenu({ chats, chatId, title, onOpen, onRename, onDelete }: { chats: Chat[] | undefined; chatId: string | null; title: string; onOpen: (id: string | null) => void; onRename?: () => void; onDelete?: () => void }) {
  // When the menu opened: how long ago each chat was used is read from then.
  const [now, setNow] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  const act = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <span className="anchor" ref={box}>
      <button className="cs" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => (setNow(Date.now()), setOpen(!open))}>
        {title}
        <Icon name="down" />
      </button>
      {open && (
        <div className="menu cmenu">
          <div className="pt">Chats in this project</div>
          <div className="cmenu-list">
          {(chats ?? []).map((c) => (
            <button key={c.id} className={`mi${c.id === chatId ? " on" : ""}`} type="button" aria-current={c.id === chatId ? "true" : undefined} onClick={act(() => onOpen(c.id))}>
              <span>{c.title || "Untitled chat"}</span>
              <small>{ago(c.updatedAt, now)}</small>
            </button>
          ))}
          {chats?.length === 0 && <div className="muted">No saved chats yet. Your first message starts one.</div>}
          </div>
          <div className="cmenu-foot">
          <hr />
          <button className="mi new" type="button" onClick={act(() => onOpen(null))}>
            <Icon name="plus" />
            New chat
          </button>
          {onRename && (
            <button className="mi" type="button" onClick={act(onRename)}>
              Rename this chat
            </button>
          )}
          {onDelete && (
            <button className="mi danger" type="button" onClick={act(onDelete)}>
              Delete this chat…
            </button>
          )}
          </div>
        </div>
      )}
    </span>
  );
}
