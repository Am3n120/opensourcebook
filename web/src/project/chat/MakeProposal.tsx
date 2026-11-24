import type { MakePiece } from "../../api/types";
import { useAppData, useFormats } from "../../app/context";
import { FormatTile } from "../../design/FormatTile";
import { findFormat } from "../../design/formatLook";
import { rowPick } from "../../make/madeBy";
import { agentField, turnKindOf } from "../../make/makerKey";
import { pickWords } from "../../plan/panelModel";
import type { PieceProps } from "../pieces";
import { useChatActions } from "./actions";
import { proposalLine } from "./commands";

/**
 * A thing asked for in the chat (engine/docs/api.md, "Making one thing"):
 * nothing is made until the person presses its sheet's button. Open, it is
 * one quiet row that opens the sheet again; once made, the thing it made as
 * its card, with Play or Open; closed, a line saying it was not made.
 */
export function MakePieceView({ piece, message, index }: PieceProps<MakePiece>) {
  const chat = useChatActions();
  const formats = useFormats();
  const { providers } = useAppData();
  const format = findFormat(formats, piece.format);
  const shape = format?.singular ?? format?.label ?? piece.format;
  if (piece.state === "made" && piece.planId) return <>{chat?.madeCard(piece.planId) ?? null}</>;
  if (piece.state === "closed")
    return (
      <p className="mkp closed" role="note">
        <FormatTile id={piece.format} formats={formats} size="sm" />
        <span>
          {piece.title || `A ${shape}`} <small>· not made</small>
        </span>
      </p>
    );
  const picked = format && agentField(format, "maker") ? rowPick(format, piece.settings, "maker", providers?.picks).pick : null;
  const maker = picked && format ? pickWords(picked, providers?.providers ?? [], turnKindOf(format, "maker")) : undefined;
  return (
    <div className="mkp" role="group" aria-label={`${piece.title || shape}, its make sheet`}>
      <FormatTile id={piece.format} formats={formats} size="sm" />
      <span className="mkp-tx">
        <b>{piece.title || `A ${shape}`}</b>
        <small>{piece.issues.length > 0 ? piece.issues[0] : proposalLine(shape, piece.plannedAs, maker)}</small>
      </span>
      {chat && index !== undefined && (
        <button type="button" className="obtn" onClick={() => chat.openMake(piece, message.id, index)}>
          Open its sheet
        </button>
      )}
    </div>
  );
}
