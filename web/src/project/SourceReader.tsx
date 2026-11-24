import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { PlanView } from "../api/types";
import { useApi, useFormats } from "../app/context";
import { LoadState } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { FormatTile } from "../design/FormatTile";
import { OUTLINE_BUTTON } from "../design/Buttons";
import { Icon } from "../design/Icon";
import { RenameSource } from "../sources/SourceActions";
import { extractionText, readMark } from "../sources/sourceText";
import { markSpan, type Spot } from "./spot";
import { Markdown } from "../sources/MarkdownText";
import { PaperText } from "../sources/PaperText";
import { looksLikeMarkdown } from "../sources/mdBlocks";

/**
 * A source opened beside the chat: its text, with which items read it one
 * tap away. A cited spot is marked and scrolled into view; within it, the
 * quoted words when they are found.
 */
export function SourceReader({ sourceId, views, onClose, spot, onRenamed }: { sourceId: string; views: PlanView[]; onClose?: () => void; spot?: Spot; /** The source's name changed here, so lists showing it read it again. */ onRenamed?: () => void }) {
  const client = useApi();
  const mark = useRef<HTMLElement>(null);
  const [showUsed, setShowUsed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const formats = useFormats();
  const detail = useLoad(() => client.getSource(sourceId), [client, sourceId]);
  const used = views.flatMap((v) => v.items.filter((i) => i.sources.some((s) => s.sourceId === sourceId)).map((item) => ({ item, plan: v.plan })));

  if (!detail.data)
    return (
      <section className="col reader" aria-label="Source">
        <div className="sc">
          <LoadState loading={detail.loading} error={detail.error} what="the source" />
        </div>
      </section>
    );
  const { source, extraction } = detail.data;
  const text = extraction.text ?? "";
  const marked = spot ? markSpan(text, spot) : undefined;
  const st = extractionText(extraction.status);
  const title = source.title;
  const removed = source.removedAt !== undefined;
  const partly = readMark({ status: extraction.status, accessLevel: extraction.accessLevel });
  // Where it came from: its link, or the file it was uploaded as, kept by the engine.
  const file = source.url ?? (source.uploadId ? client.sourceFileUrl(source.id) : undefined);
  // The engine sends an uploaded file as a download unless it is a picture, sound, video or PDF.
  const downloads = source.url === undefined && source.uploadId !== undefined && !/^(image|audio|video|pdf)|^(image|audio|video)\/|\/pdf$/i.test(extraction.kind || source.kind);
  return (
    <section className="col reader" aria-label="Source">
      <div className="hd">
        {onClose && (
          <button className="ib" type="button" aria-label="Sources" title="Back to sources" onClick={onClose}>
            <Icon name="chev-l" />
          </button>
        )}
        <div className="rtitle">
          {renaming ? (
            <RenameSource
              className="ttl"
              source={{ ...source, status: extraction.status }}
              onDone={(renamed) => {
                setRenaming(false);
                if (!renamed) return;
                void detail.reload();
                onRenamed?.();
              }}
            />
          ) : removed ? (
            <h2 className="ttl">{title}</h2>
          ) : (
            <h2 className="ttl">
              <button type="button" title="Rename" onClick={() => setRenaming(true)}>
                {title}
              </button>
            </h2>
          )}
          <small className="rmeta">
            {[source.kind, extraction.status !== "ready" ? st.text : undefined, partly].filter(Boolean).join(" · ")}
          </small>
        </div>
        <span className="sp" />
        {(file || used.length > 0) && (
          <div className="rside">
            {file && (
              <a className={OUTLINE_BUTTON} href={file} target="_blank" rel="noreferrer">
                {downloads ? "Download the file" : "Open the file"}
              </a>
            )}
            {used.length > 0 && (
              <button className="usedby" type="button" aria-expanded={showUsed} onClick={() => setShowUsed(!showUsed)}>
                Used by {used.length} item{used.length === 1 ? "" : "s"}
                <Icon name="down" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="sc">
        {removed && (
          <div className="notice" role="status">
            This source was removed. Its text stays here so answers and things made from it can still open it.
          </div>
        )}
        {extraction.errorMessage && <div className="notice error">{extraction.errorMessage}</div>}
        {extraction.limitations && extraction.limitations.length > 0 && (
          <div className="notice warn">
            <div>
              What could not be read
              {extraction.limitations.length === 1 ? (
                <>: {extraction.limitations[0]}</>
              ) : (
                <ul>
                  {extraction.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        {showUsed && (
          <div className="used">
            {used.map(({ item, plan }) => (
              <Link key={item.id} to={item.outputId ? `/outputs/${item.outputId}` : `/projects/${plan.projectId}?plan=${plan.id}`}>
                <FormatTile id={item.type} formats={formats} size="sm" />
                <span className="nm">{item.title}</span>
                <small>{plan.title || "Untitled plan"}</small>
              </Link>
            ))}
          </div>
        )}
        <div className="paper">
          <div className="kick">
            {source.kind} · {new Date(source.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            {extraction.status !== "ready" && <span className={`st ${st.tone}`}> · {st.text}</span>}
            {partly && <span> · {partly}</span>}
          </div>
          <h3>{title}</h3>
          {text && looksLikeMarkdown(source.title ?? title, source.kind, text) ? (
            <Markdown text={text} {...(marked ? { marked } : {})} mark={mark} {...(spot?.n !== undefined ? { cite: spot.n } : {})} />
          ) : (
          !text ? (
            <p className="body">No text was extracted from this source.</p>
          ) : (
            <PaperText text={text} marked={marked} mark={mark} title={title} {...(spot?.n !== undefined ? { cite: spot.n } : {})} />
          )
          )}
          <ScrollTo target={mark} when={marked?.join("-")} />
        </div>
      </div>
    </section>
  );
}

/**
 * Brings the marked spot into the middle of the reader (its top, when it is
 * taller than the reader), and again a moment later: the panel may still be
 * settling into its place beside the chat when the spot is first drawn.
 */
function ScrollTo({ target, when }: { target: React.RefObject<HTMLElement | null>; when?: string }) {
  useEffect(() => {
    if (!when) return;
    const go = (smooth: boolean) => {
      const el = target.current;
      const box = el?.closest<HTMLElement>(".sc");
      if (!el || !box) return void el?.scrollIntoView?.({ block: "center" });
      const r = el.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const off = r.height > b.height * 0.8 ? r.top - b.top - 24 : r.top - b.top - (b.height - r.height) / 2;
      if (Math.abs(off) > 12) box.scrollTo?.({ top: box.scrollTop + off, behavior: smooth ? "smooth" : "auto" });
    };
    const frame = requestAnimationFrame(() => go(true));
    const again = window.setTimeout(() => go(false), 450);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(again);
    };
  }, [target, when]);
  return null;
}
