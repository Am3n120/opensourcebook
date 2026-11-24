import { useContext, useId, useState, type ReactNode } from "react";
import type { Json, JsonObject } from "../api/types";
import { linkUrl, mediaUrl, youtubeEmbed } from "./media";

/**
 * Draws the blocks of a card (engine/src/cards/blocks.ts; the phone's
 * BlockCanvasView draws the same types). Every field
 * is read defensively: a payload is data, and a block type this client does
 * not know shows a quiet placeholder instead of breaking the page.
 */
import { ASKS, asBlocks, mixedOrder, type Block } from "./blockData";
import { CardSideContext } from "./cardSide";
import { Inline } from "./inline";
import { blockQuestion } from "./quiz/blockQuestions";
import { pieceOf } from "./quiz/pieces";
import { outcomeOf, sameAnswer, type Response } from "./quizGrade";
import { TeX } from "./TeX";
import { withoutVerdict } from "./verdict";

const str = (v: Json | undefined): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: Json | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const obj = (v: Json | undefined): JsonObject => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {});
const strs = (v: Json | undefined): string[] => arr(v).filter((x): x is string => typeof x === "string");


/** Blocks that ask something: their cite marks come with the explanation, once answered, so a quoted source never gives the answer away. */
const CHECKS = [...ASKS];

/** Blocks whose cite marks sit at the end of their own words; any other block's sit on a line under it. */
const MARKED_INLINE = new Set(["text", "quote", "callout", "definition", "bullets", "numbered", "checklist", "cloze", ...CHECKS]);

/** `marks(i)` gives the cite marks of block i, drawn at the end of the claim it holds (CiteMarks.tsx). */
export function Blocks({ blocks, marks }: { blocks: Block[]; marks?: (index: number) => ReactNode }) {
  return (
    <div className="blocks">
      {blocks.map((b, i) => {
        const tail = marks?.(i);
        if (!tail || MARKED_INLINE.has(b.type)) return <BlockView key={i} block={b} tail={tail} />;
        return (
          <div key={i} className="bmarked">
            <BlockView block={b} />
            <p className="bmarks">{tail}</p>
          </div>
        );
      })}
    </div>
  );
}

function Img({ url, alt }: { url: string | undefined; alt: string }) {
  const src = mediaUrl(url);
  return src ? <img src={src} alt={alt} loading="lazy" /> : null;
}

function ExtLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const safe = linkUrl(href);
  return safe ? (
    <a href={safe} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="tbl">
      <table>
        {headers.length > 0 && (
          <thead>
            <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
          </thead>
        )}
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bars({ title, items }: { title?: string; items: Array<{ label: string; value: number; display?: string }> }) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return (
    <figure className="chart">
      {title && <figcaption>{title}</figcaption>}
      {items.map((i, k) => (
        <div className="barrow" key={k}>
          <span className="bl">{i.label}</span>
          <span className="bt">
            <i style={{ width: `${(Math.abs(i.value) / max) * 100}%` }} />
          </span>
          <span className="bv">{i.display ?? i.value}</span>
        </div>
      ))}
    </figure>
  );
}

/** A sentence with its key parts hidden until the card turns over; each part keeps its inline marks. */
function Cloze({ text, tail }: { text: string; tail?: ReactNode }) {
  const { revealed } = useContext(CardSideContext);
  const parts = text.split(/\[\[([^[\]]+)\]\]/);
  return (
    <p className="btext bcloze">
      {parts.map((part, i) =>
        i % 2 === 0 ? (
          <Inline key={i} text={part} />
        ) : revealed ? (
          <mark key={i} className="gap shown">
            <Inline text={part} />
          </mark>
        ) : (
          <span key={i} className="gap" aria-label="hidden">
            {"\u2009".repeat(Math.min(24, Math.max(6, part.length)))}
          </span>
        ),
      )}
      {tail}
    </p>
  );
}

/** What a check on a card says once answered: one verdict, then why (verdict.ts). */
function Said({ right, verdict, why, tail }: { right: boolean; verdict?: string; why?: string | undefined; tail?: ReactNode }) {
  const explanation = withoutVerdict(why);
  return (
    <p className={`expl ${right ? "right" : "wrong"}`} role="status">
      <b>{verdict ?? (right ? "Right." : "Not quite.")}</b>
      {explanation && <> <Inline text={explanation} /></>}
      {tail}
    </p>
  );
}

function Quiz({ block, tail }: { block: Block; tail?: ReactNode }) {
  const options = strs(block.options);
  const correct = num(block.correctIndex);
  const [picked, setPicked] = useState<number>();
  const { answered } = useContext(CardSideContext);
  return (
    <div className="quiz">
      <p className="q"><Inline text={str(block.question)} /></p>
      <div className="opts">
        {options.map((o, i) => (
          <button
            key={i}
            type="button"
            className={`opt${picked === undefined ? "" : i === correct ? " right" : i === picked ? " wrong" : ""}`}
            disabled={picked !== undefined}
            aria-pressed={picked === i}
            onClick={() => {
              setPicked(i);
              answered?.(i === correct);
            }}
          >
            <Inline text={o} />
          </button>
        ))}
      </div>
      {picked !== undefined && <Said right={picked === correct} why={str(block.explanation)} tail={tail} />}
    </div>
  );
}

/** Fill in the blank: the person picks or types first; then whether it was right, the answer, and why. */
function FillIn({ block, tail }: { block: Block; tail?: ReactNode }) {
  const options = strs(block.options);
  const answer = str(block.answer) ?? "";
  const [given, setGiven] = useState<string>();
  const [typed, setTyped] = useState("");
  const { answered } = useContext(CardSideContext);
  const give = (value: string) => {
    setGiven(value);
    answered?.(value !== "" && sameAnswer(value, answer));
  };
  const right = given !== undefined && sameAnswer(given, answer);
  return (
    <div className="quiz">
      <p className="q"><Inline text={str(block.prompt)} /></p>
      {options.length > 0 ? (
        <div className="opts">
          {options.map((o, i) => (
            <button key={i} type="button" className={`opt${given === undefined ? "" : sameAnswer(o, answer) ? " right" : o === given ? " wrong" : ""}`} disabled={given !== undefined} onClick={() => give(o)}>
              {o}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="fillin"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) give(typed);
          }}
        >
          <input className="ipt" aria-label="Your answer" value={typed} disabled={given !== undefined} onChange={(e) => setTyped(e.target.value)} />
          {given === undefined && (
            <button type="submit" className="btn small soft" disabled={!typed.trim()}>
              Check
            </button>
          )}
        </form>
      )}
      {given === undefined && options.length === 0 && (
        <button type="button" className="link small" onClick={() => give("")}>
          Show the answer
        </button>
      )}
      {given !== undefined && <Said right={right} verdict={given === "" ? `The answer: ${answer}.` : right ? "Right." : `Not quite. The answer: ${answer}.`} why={str(block.explanation)} tail={tail} />}
    </div>
  );
}

/** Matching: each left item is matched from the right ones in a mixed order, then checked. */
function Matching({ block, tail }: { block: Block; tail?: ReactNode }) {
  const pairs = arr(block.pairs).map(obj).map((p) => ({ left: str(p.left) ?? "", right: str(p.right) ?? "" }));
  const order = mixedOrder(pairs.length, pairs.map((p) => p.right).join("|"));
  const [chosen, setChosen] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState(false);
  const { answered } = useContext(CardSideContext);
  const all = pairs.every((_, i) => chosen[i] !== undefined);
  const right = pairs.filter((_, i) => chosen[i] === i).length;
  return (
    <div className="quiz">
      {str(block.prompt) && <p className="q"><Inline text={str(block.prompt)} /></p>}
      <div className="match">
        {pairs.map((p, i) => (
          <label key={i} className={checked ? (chosen[i] === i ? "right" : "wrong") : ""}>
            <span><Inline text={p.left} /></span>
            <select value={chosen[i] ?? ""} disabled={checked} onChange={(e) => setChosen({ ...chosen, [i]: Number(e.target.value) })}>
              <option value="" disabled>
                Pick…
              </option>
              {order.map((k) => (
                <option key={k} value={k}>
                  {pairs[k]!.right}
                </option>
              ))}
            </select>
            {checked && chosen[i] !== i && <small>{p.right}</small>}
          </label>
        ))}
      </div>
      {!checked ? (
        <button type="button" className="btn small soft" disabled={!all} onClick={() => { setChecked(true); answered?.(right === pairs.length); }}>
          Check
        </button>
      ) : (
        <Said right={right === pairs.length} verdict={right === pairs.length ? "Right." : `${right} of ${pairs.length} matched.`} tail={tail} />
      )}
    </div>
  );
}

/**
 * A block that asks as a kind of quiz question does (labelPicture, drawLine;
 * quiz/blockQuestions.ts): the kind's own piece draws it, the kind's own
 * grader marks it, and only a fully right answer marks the card got it.
 */
function AskedBlock({ block, tail }: { block: Block; tail?: ReactNode }) {
  const id = useId();
  const [response, setResponse] = useState<Response>();
  const { answered } = useContext(CardSideContext);
  const asked = blockQuestion(block);
  const piece = asked && pieceOf(asked.question.kind);
  if (!asked || !piece) return <p className="bunknown">This part ({block.type}) has no web view yet.</p>;
  const q = { ...asked.question, id: `${asked.question.id}${id.replace(/[^A-Za-z0-9_-]/g, "")}` };
  const outcome = response ? outcomeOf(q, response) : undefined;
  return (
    <div className="quiz">
      {q.prompt && <p className="q"><Inline text={q.prompt} /></p>}
      <piece.View
        q={q}
        response={response}
        reveal
        onAnswer={(r) => {
          setResponse(r);
          answered?.(outcomeOf(q, r) === "right");
        }}
      />
      {response && outcome && <Said right={outcome === "right"} verdict={asked.entry.verdict?.(q, response, outcome)} why={str(block.explanation)} tail={tail} />}
    </div>
  );
}

function Card({ front, back }: { front: string; back: string }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <button type="button" className={`flash${flipped ? " back" : ""}`} onClick={() => setFlipped(!flipped)} aria-label={flipped ? `Back: ${back}` : `Front: ${front}. Show the back`}>
      {flipped ? back : front}
      <span className="side" aria-hidden="true">
        {flipped ? "Back · tap to turn over" : "Tap to turn over"}
      </span>
    </button>
  );
}

/** Ordering: the items start mixed; the person moves them into order, then checks. */
function OrderExercise({ block, tail }: { block: Block; tail?: ReactNode }) {
  const items = strs(block.items);
  const written = arr(block.correctOrder).filter((n): n is number => typeof n === "number");
  const correct = written.length === items.length ? written : items.map((_, i) => i);
  const [now, setNow] = useState(() => mixedOrder(items.length, items.join("|")).map((k) => correct[k]!));
  const [checked, setChecked] = useState(false);
  const right = now.every((k, i) => k === correct[i]);
  const { answered } = useContext(CardSideContext);
  const move = (i: number, by: number) => {
    const next = [...now];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    setNow(next);
  };
  return (
    <div className="quiz">
      <p className="q"><Inline text={str(block.prompt)} /></p>
      <ol className="order">
        {now.map((k, i) => (
          <li key={k} className={checked ? (k === correct[i] ? "right" : "wrong") : ""}>
            <span><Inline text={items[k] ?? ""} /></span>
            {!checked && (
              <span className="mv">
                <button type="button" aria-label={`Move up: ${items[k]}`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" aria-label={`Move down: ${items[k]}`} disabled={i === now.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {!checked ? (
        <button type="button" className="btn small soft" onClick={() => { setChecked(true); answered?.(right); }}>
          Check the order
        </button>
      ) : (
        <>
          <Said right={right} verdict={right ? "Right." : "Not quite. The right order:"} tail={tail} />
          {!right && <ol className="order">{correct.map((k) => <li key={k}><Inline text={items[k] ?? ""} /></li>)}</ol>}
        </>
      )}
    </div>
  );
}

export function BlockView({ block, tail }: { block: Block; tail?: ReactNode }) {
  const b = block;
  switch (b.type) {
    case "kicker":
      return <p className="kicker">{str(b.text)}</p>;
    case "heading":
      return <h2 className="bh">{str(b.text)}</h2>;
    case "subheading":
      return <h3 className="bsh">{str(b.text)}</h3>;
    case "text":
      return <p className="btext"><Inline text={str(b.text)} />{tail}</p>;
    case "quote":
      return (
        <blockquote className="bquote">
          <Inline text={str(b.text)} />
          {tail}
          {(str(b.author) || str(b.source)) && <cite>{[str(b.author), str(b.source)].filter(Boolean).join(", ")}</cite>}
        </blockquote>
      );
    case "divider":
      return <hr />;
    case "continuation":
    case "spacer":
      return <div className="bspace" />;
    case "image":
    case "figure":
    case "hero":
      return mediaUrl(str(b.url)) ? (
        <figure className="bfig">
          <Img url={str(b.url)} alt={str(b.caption) ?? str(b.title) ?? ""} />
          {(str(b.caption) || str(b.title) || str(b.credit)) && (
            <figcaption>
              {str(b.title) && <b>{str(b.title)} </b>}
              {str(b.caption) ?? str(b.subtitle)}
              {str(b.credit) && <small> · {str(b.credit)}</small>}
            </figcaption>
          )}
        </figure>
      ) : str(b.caption) ? (
        <p className="d">{str(b.caption)}</p>
      ) : null;
    case "gallery":
    case "carousel": {
      const images = arr(b.images ?? b.items).map(obj);
      return (
        <div className="bgal">
          {images.map((im, i) => (
            <figure key={i} className="bfig">
              <Img url={str(im.url)} alt={str(im.caption) ?? ""} />
              {str(im.caption) && <figcaption>{str(im.caption)}</figcaption>}
            </figure>
          ))}
        </div>
      );
    }
    case "video":
      return str(b.youtubeID) ? (
        <div className="bvid">
          <iframe src={youtubeEmbed(str(b.youtubeID)!)} title={str(b.title) ?? "Video"} allowFullScreen loading="lazy" />
        </div>
      ) : null;
    case "audio":
    case "audioClip":
      return mediaUrl(str(b.url)) ? (
        <figure className="baud">
          {str(b.title) && <figcaption>{str(b.title)}</figcaption>}
          <audio controls src={mediaUrl(str(b.url))} preload="none" />
        </figure>
      ) : null;
    case "clip":
    case "embed":
      return (
        <p className="blink">
          <ExtLink href={str(b.url)}>{str(b.title) ?? str(b.url) ?? "Open"}</ExtLink>
        </p>
      );
    case "linkCard":
    case "linkPreview":
      return (
        <div className="card blinkcard">
          <ExtLink href={str(b.url)}>
            <b>{str(b.title) ?? str(b.url)}</b>
          </ExtLink>
          <div className="d">
            {str(b.domain)}
            {str(b.description) && ` · ${str(b.description)}`}
          </div>
        </div>
      );
    case "callout":
      return (
        <aside className={`bcall ${str(b.style) ?? "info"}`}>
          {str(b.title) && <b>{str(b.title)}</b>}
          <p><Inline text={str(b.text)} />{tail}</p>
        </aside>
      );
    case "bullets":
    case "checklist":
      return <ul className="blist">{strs(b.items).map((t, i, all) => <li key={i}><Inline text={t} />{i === all.length - 1 && tail}</li>)}</ul>;
    case "numbered":
      return <ol className="blist">{strs(b.items).map((t, i, all) => <li key={i}><Inline text={t} />{i === all.length - 1 && tail}</li>)}</ol>;
    case "toc":
      return (
        <nav className="card btoc" aria-label={str(b.title) ?? "Contents"}>
          {str(b.title) && <b>{str(b.title)}</b>}
          <ol>{strs(b.items).map((t, i) => <li key={i}>{t}</li>)}</ol>
        </nav>
      );
    case "metrics":
      return (
        <div className="bmetrics">
          {arr(b.stats).map(obj).map((s, i) => (
            <div key={i} className="card">
              <b>{str(s.value)}</b>
              <span>{str(s.label)}</span>
              {str(s.delta) && <small>{str(s.delta)}</small>}
            </div>
          ))}
        </div>
      );
    case "bigStat":
      return (
        <div className="bbig">
          <b>{str(b.value)}</b>
          <span>{str(b.label)}</span>
          {str(b.delta) && <small>{str(b.delta)}</small>}
        </div>
      );
    case "gauge":
      return (
        <div className="bbig">
          <b>{num(b.value) !== undefined ? `${Math.round(num(b.value)! * (num(b.value)! <= 1 ? 100 : 1))}%` : ""}</b>
          <span>{str(b.label)}</span>
          {str(b.detail) && <small>{str(b.detail)}</small>}
        </div>
      );
    case "table":
      return <Table headers={strs(b.headers)} rows={arr(b.rows).map(strs)} />;
    case "timeline":
      return (
        <ol className="btime">
          {arr(b.items).map(obj).map((t, i) => (
            <li key={i}>
              <span className="d">{str(t.label)}</span>
              <b>{str(t.title)}</b>
              {str(t.detail) && <p>{str(t.detail)}</p>}
            </li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre className="bcode" data-language={str(b.language)}>
          <code>{str(b.text)}</code>
        </pre>
      );
    case "math":
      return (
        <figure className="bmath">
          <TeX source={str(b.latex) ?? ""} display />
          {str(b.caption) && <figcaption>{str(b.caption)}</figcaption>}
        </figure>
      );
    case "background":
      // What the maker added to help, not from the person's source: its own look, its own label, never a cite.
      return (
        <aside className="bbg" aria-label="Background, not from your source">
          <span className="bbg-tag">Background · not from your source</span>
          {str(b.title) && <b>{str(b.title)}</b>}
          <p>
            <Inline text={str(b.text)} />
          </p>
        </aside>
      );
    case "definition":
      return (
        <dl className="bdef">
          <dt>{str(b.term)}</dt>
          <dd>
            <Inline text={str(b.definition)} />
            {str(b.source) && <small> · {str(b.source)}</small>}
            {tail}
          </dd>
        </dl>
      );
    case "prosCons": {
      const pros = obj(b.pros);
      const cons = obj(b.cons);
      return (
        <div className="bpc">
          <div>
            <b>{str(pros.title) ?? "For"}</b>
            <ul>{strs(pros.items).map((t, i) => <li key={i}><Inline text={t} /></li>)}</ul>
          </div>
          <div>
            <b>{str(cons.title) ?? "Against"}</b>
            <ul>{strs(cons.items).map((t, i) => <li key={i}><Inline text={t} /></li>)}</ul>
          </div>
        </div>
      );
    }
    case "quiz":
      return <Quiz block={b} tail={tail} />;
    case "fillInBlank":
      return <FillIn block={b} tail={tail} />;
    case "cloze":
      return <Cloze text={str(b.text) ?? ""} tail={tail} />;
    case "flashcards":
      return (
        <div className="bcards">
          {arr(b.cards).map(obj).map((c, i) => (
            <Card key={i} front={str(c.front) ?? ""} back={str(c.back) ?? ""} />
          ))}
        </div>
      );
    case "matching":
      return <Matching block={b} tail={tail} />;
    case "orderExercise":
      return <OrderExercise block={b} tail={tail} />;
    case "labelPicture":
    case "drawLine":
      return <AskedBlock block={b} tail={tail} />;
    case "reveal":
      return (
        <details className="breveal">
          <summary>{str(b.title) ?? "Show more"}</summary>
          <Blocks blocks={asBlocks(b.blocks)} />
        </details>
      );
    case "barChart":
      return <Bars title={str(b.title)} items={arr(b.items).map(obj).map((i) => ({ label: str(i.label) ?? "", value: num(i.value) ?? 0, display: str(i.displayValue) }))} />;
    case "histogram":
      return <Bars title={str(b.title)} items={arr(b.bins).map(obj).map((i) => ({ label: str(i.label) ?? "", value: num(i.count) ?? 0 }))} />;
    case "pie":
      return <Bars title={str(b.title)} items={arr(b.items).map(obj).map((i) => ({ label: str(i.label) ?? "", value: num(i.value) ?? 0, display: str(i.displayValue) }))} />;
    case "lineChart":
    case "areaChart":
    case "stackedBar":
    case "radar": {
      const labels = strs(b.xLabels ?? b.categories ?? b.axes);
      const series = arr(b.series).map(obj);
      return (
        <figure className="chart">
          {str(b.title) && <figcaption>{str(b.title)}</figcaption>}
          <Table headers={["", ...labels]} rows={series.map((s) => [str(s.name) ?? "", ...arr(s.values).map((v) => String(v))])} />
        </figure>
      );
    }
    case "scatter":
      return (
        <figure className="chart">
          {str(b.title) && <figcaption>{str(b.title)}</figcaption>}
          <Table headers={[str(b.xLabel) ?? "x", str(b.yLabel) ?? "y", ""]} rows={arr(b.points).map(obj).map((p) => [String(num(p.x) ?? ""), String(num(p.y) ?? ""), str(p.label) ?? ""])} />
        </figure>
      );
    case "heatmap":
      return (
        <figure className="chart">
          {str(b.title) && <figcaption>{str(b.title)}</figcaption>}
          <Table headers={["", ...strs(b.xLabels)]} rows={strs(b.yLabels).map((y, i) => [y, ...arr(arr(b.values)[i]).map((v) => String(v))])} />
        </figure>
      );
    case "map":
      return (
        <ul className="blist">
          {arr(b.places).map(obj).map((p, i) => (
            <li key={i}>
              <b>{str(p.name)}</b>
              {str(p.note) && ` · ${str(p.note)}`}
            </li>
          ))}
        </ul>
      );
    case "timer":
      return (
        <p className="d">
          {str(b.label)}: {Math.round((num(b.seconds) ?? 0) / 60)} min
        </p>
      );
    case "servingsScaler":
      return <ul className="blist">{arr(b.ingredients).map(obj).map((g, i) => <li key={i}>{[num(g.quantity), str(g.unit), str(g.name)].filter((x) => x !== undefined).join(" ")}</li>)}</ul>;
    default:
      return <p className="bunknown">This part ({b.type}) has no web view yet.</p>;
  }
}
