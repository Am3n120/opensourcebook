import type { TeachBackPiece } from "../../api/types";
import { Icon } from "../../design/Icon";
import { Cites, Words } from "../pieceViews";
import type { PieceProps } from "../pieces";
import { VERDICT_GROUPS } from "../verdicts";
import { useChatActions } from "./actions";

const MARK: Record<string, string> = { right: "check", missing: "plus", wrong: "alert" };

/**
 * The person's own explanation checked against the sources: how many of the
 * main points they got, one segment per point, then what they got right,
 * what they left out and what the sources say differently, each point with
 * its cites. "Explain it again" starts another try in the box; "Open the
 * passages" opens the first spot cited. It answers in the chat and makes
 * nothing.
 */
export function TeachBackPieceView(props: PieceProps<TeachBackPiece>) {
  const { piece, message, onOpenCite } = props;
  const chat = useChatActions();
  const items = Array.isArray(piece.items) ? piece.items : [];
  const groups = VERDICT_GROUPS.map((group) => ({ ...group, items: items.filter((item) => item.verdict === group.verdict) })).filter((group) => group.items.length > 0);
  const right = items.filter((item) => item.verdict === "right").length;
  const shown = groups.flatMap((g) => g.items);
  const cites = message.cites ?? [];
  const first = [...shown.flatMap((item) => item.cites ?? []), ...(piece.cites ?? [])].find((c) => cites[c]);
  return (
    <div className="blk tb" role="group" aria-label="Your explanation, checked against your sources">
      {items.length > 0 && (
        <div className="tb-hd">
          <b>
            You got {right} of the {items.length} main point{items.length === 1 ? "" : "s"}
          </b>
          <span className="tb-bar" aria-hidden="true">
            {shown.map((item, k) => (
              <span key={k} className={item.verdict} />
            ))}
          </span>
        </div>
      )}
      <div className="tb-body">
        {groups.map((group) => (
          <section key={group.verdict} className={`tbg ${group.verdict}`} aria-label={group.heading}>
            <h4>{group.heading}</h4>
            <ul>
              {group.items.map((item, k) => (
                <li key={k}>
                  <span className="tbm" aria-hidden="true">
                    <Icon name={MARK[group.verdict] ?? "dot"} />
                  </span>
                  <span>
                    <Words text={item.text} {...props} />
                    <Cites of={item} {...props} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <Cites of={piece} {...props} />
      </div>
      {(chat?.canAgain(message) || first !== undefined) && (
        <div className="tb-ft" data-copy="skip">
          {chat?.canAgain(message) && (
            <button type="button" className="tb-again" onClick={() => chat.again(message)}>
              Explain it again
            </button>
          )}
          {first !== undefined && (
            <button type="button" className="obtn" onClick={() => onOpenCite(cites[first]!)}>
              Open the passages
            </button>
          )}
        </div>
      )}
    </div>
  );
}
