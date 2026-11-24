import { useId, useState } from "react";
import { Link } from "react-router";
import { errorText } from "../../api/errors";
import type { AgentPickPatch, Providers, VoiceSetup } from "../../api/types";
import { useAppData } from "../../app/context";
import { useLoad, type Loaded } from "../../app/useLoad";
import { FormatTile } from "../../design/FormatTile";
import { Icon } from "../../design/Icon";
import { PickRow } from "../../design/PickRow";
import { ProviderMark } from "../../design/ProviderMark";
import { Picker } from "../../make/Picker";
import { MakerPicker, type MakerPick } from "../../make/MakerPicker";
import { turnKindOf } from "../../make/makerKey";
import type { TimeWords } from "../../make/makeTime";
import { onRail } from "../../project/providers";
import { VoicePicker } from "../../voice/VoicePicker";
import { SectionHead } from "./SectionHead";
import {
  hasMaker,
  hasReviewer,
  lengthWords,
  makerRows,
  makerScopes,
  pickOf,
  pickWords,
  reviewOf,
  rowTime,
  useAllTimes,
  voiceWords,
  withPick,
  type MakerRow,
} from "./makers";

/** Which picker is open: a row's maker or reviewer, every row's maker at once, the voice (anchored to its cell), or (on a phone) a row's choices. */
type Open = { kind: "maker" | "reviewer" | "row"; row: MakerRow } | { kind: "all" } | { kind: "voice"; anchor: HTMLElement | null } | null;

const rowName = (row: MakerRow) => (row.format ? row.format.label : "The chat");

/** What a row's cells read and change, shared by the table and the phone's list. */
function useMakers() {
  const app = useAppData();
  const { client } = app;
  // The shared copies load once at the start and a failure there is swallowed, so Settings asks again for what is missing: a failed load is a failure, never an empty list.
  const needProviders = !app.providers;
  const needFormats = app.formats.length === 0;
  const backup = useLoad(
    async () => ({
      providers: needProviders ? await client.providers() : undefined,
      formats: needFormats ? await client.formats() : undefined,
    }),
    [client, needProviders, needFormats],
  );
  const providers = app.providers ?? backup.data?.providers;
  const formats = needFormats ? (backup.data?.formats ?? []) : app.formats;
  const rows = makerRows(formats);
  const loadState: "ready" | "loading" | "failed" = providers && formats.length > 0 ? "ready" : backup.loading ? "loading" : "failed";
  const retry = () => void backup.reload();
  const times = useAllTimes();
  const voice = useLoad(() => client.voice(), [client]);
  const [open, setOpen] = useState<Open>(null);
  const [error, setError] = useState<unknown>();

  async function save(scope: string, patch: AgentPickPatch) {
    setError(undefined);
    try {
      const { pick } = await client.putProviderPick(scope, patch);
      if (providers) app.setProviders?.(withPick(providers, scope, pick));
    } catch (e) {
      setError(e);
    }
  }
  async function saveAll(pick: MakerPick) {
    setError(undefined);
    const patch: AgentPickPatch = { agent: pick.agent, model: pick.model ?? null, effort: pick.effort ?? null };
    try {
      const { picks } = await client.putProviderPicks(Object.fromEntries(makerScopes(formats).map((scope) => [scope, patch])));
      if (providers) app.setProviders?.({ ...providers, picks });
    } catch (e) {
      setError(e);
    }
  }
  const canPick = !!providers?.providers.some(onRail);
  return { providers, formats, rows, times, voice, open, setOpen, error, save, saveAll, canPick, loadState, retry };
}

/** The pickers a row's cell (or "Use one for all") opens. */
function MakerDialogs({ makers }: { makers: ReturnType<typeof useMakers> }) {
  const { open, setOpen, providers, save, saveAll, voice } = makers;
  if (!open) return null;
  const close = () => setOpen(null);
  if (open.kind === "voice") return <VoicePicker anchor={open.anchor} {...(voice.data ? { setup: voice.data } : {})} onChange={voice.set} onClose={close} />;
  if (open.kind === "all") {
    return (
      <MakerPicker
        scope="chat"
        title="Use one for all"
        note="Sets who answers the chat and who makes every shape. Each can still be changed on its own after."
        noTimes
        value={null}
        confirmLabel="Use for all"
        onClose={close}
        onChange={(pick) => pick && void saveAll(pick)}
      />
    );
  }
  const { row } = open;
  if (open.kind === "row") return <RowSheet makers={makers} row={row} />;
  if (open.kind === "maker") {
    const plural = row.format ? (row.format.plural ?? `${row.format.label}s`) : undefined;
    return (
      <MakerPicker
        scope={row.scope}
        value={pickOf(providers, row.scope) ?? null}
        note={plural ? `The same picker as the chat's. This one sets what every new ${row.format!.singular ?? row.format!.label} starts with.` : "Answers every chat that has not picked its own."}
        confirmLabel={plural ? `Use for ${plural}` : "Use for the chat"}
        onClose={close}
        onChange={(pick) => pick && void save(row.scope, { agent: pick.agent, model: pick.model ?? null, effort: pick.effort ?? null })}
      />
    );
  }
  const review = reviewOf(providers, row.scope);
  return (
    <MakerPicker
      scope={row.scope}
      role="reviewer"
      allowNone
      value={review.kind === "off" ? null : review.kind === "own" ? review.pick : (pickOf(providers, row.scope) ?? null)}
      note="Looks over what was made and gives the maker one more round. Off makes it quicker."
      confirmLabel="Use this"
      onClose={close}
      onChange={(pick) =>
        void save(`${row.scope}.review`, pick ? { agent: pick.agent, model: pick.model ?? null, effort: pick.effort ?? null, off: null } : { agent: null, model: null, effort: null, off: true })
      }
    />
  );
}

/** A maker or reviewer cell's words: the provider's mark, the model, and "Agent · effort". */
function Who({ pick, turnKind }: { pick: MakerPick; turnKind: "chat" | "work" }) {
  const { providers } = useAppData();
  const w = pickWords(providers?.providers ?? [], pick, turnKind);
  return (
    <>
      <ProviderMark mark={w.provider?.mark} label={w.provider?.label ?? w.title} size={16} />
      <span className="mw-two">
        <b>{w.title}</b>
        <span>{w.sub}</span>
      </span>
    </>
  );
}

function Time({ words, row }: { words: TimeWords | undefined; row: MakerRow }) {
  if (!words) return <span className="mw-dash">—</span>;
  const length = lengthWords(row.format);
  const sub = row.format ? [length && !words.muted ? `for ${length}` : undefined, words.sub].filter(Boolean).join(" · ") : ["per reply", words.sub].filter(Boolean).join(" · ");
  return (
    <span className={`mw-two${words.muted ? " muted" : ""}`}>
      <b>{words.text}</b>
      {sub && <span>{sub}</span>}
    </span>
  );
}

/** The voice's cell: what speaks now, or "Not set up"; it opens the picker of voice services under it. */
function VoiceCell({ voice, onOpen, label }: { voice: Loaded<VoiceSetup>; onOpen: (anchor: HTMLElement) => void; label: string }) {
  if (voice.loading && !voice.data) return <span className="mw-dash">…</span>;
  const words = voiceWords(voice.data);
  return (
    <button type="button" className="mw-cell" aria-label={`Voice, ${label}`} onClick={(e) => onOpen(e.currentTarget)}>
      <span className="mw-two">
        {words ? (
          <>
            <b>{words.title}</b>
            <span>{words.sub}</span>
          </>
        ) : (
          <>
            <b className="warn">{voice.data ? "Not set up" : "Can't check"}</b>
            <span>{voice.data ? "Set up voice" : "Try again"}</span>
          </>
        )}
      </span>
    </button>
  );
}

/** What shows while the providers or shapes load, and when asking for them failed: never an empty list that reads as "nothing is set up". */
function LoadState({ state, onRetry }: { state: "loading" | "failed"; onRetry: () => void }) {
  if (state === "loading") {
    return (
      <p className="setnote" role="status">
        Checking…
      </p>
    );
  }
  return (
    <div className="sx-fail" role="alert">
      <p className="setnote err">Couldn't reach the engine. Try again.</p>
      <button type="button" className="mini" onClick={onRetry}>
        <Icon name="retry" />
        Try again
      </button>
    </div>
  );
}

/** Why nothing can be picked: no agent connected, or the connector does not answer right now. */
function NoAgent({ providers }: { providers: Providers | undefined }) {
  const down = providers?.connector.configured && !providers.connector.reachable;
  return (
    <p className="setnote">
      {down ? "Your agent can't be reached right now, so nothing can be picked." : "No agent is connected yet, so nothing can be picked."} <Link to={{ hash: "#providers" }}>Open providers</Link>
    </p>
  );
}

/** Settings › What makes what: one row for the chat and each shape, and what each starts with. */
export function MakersSettings() {
  const heading = useId();
  const tip = useId();
  const makers = useMakers();
  const { providers, rows, times, voice, setOpen, error, canPick, loadState, retry } = makers;
  const [why, setWhy] = useState(false);
  return (
    <section className="sx-sec" aria-labelledby={heading}>
      <SectionHead
        id={heading}
        title="What makes what"
        action={
          <button className="obtn sx-act" type="button" disabled={!canPick} onClick={() => setOpen({ kind: "all" })}>
            Use one for all
          </button>
        }
      >
        What each thing starts with when you pick nothing. Click any cell to change it. Every make sheet and plan item starts from here, and you can still change it there for one
        thing.
      </SectionHead>
      {loadState !== "ready" ? (
        <LoadState state={loadState} onRetry={retry} />
      ) : (
        <>
      {!canPick && <NoAgent providers={providers} />}
      <div className="mw-wrap">
        <table className="mw">
          <thead>
            <tr>
              <th scope="col">For</th>
              <th scope="col">Made by</th>
              <th scope="col">Reviewed by</th>
              <th scope="col">Voice</th>
              <th scope="col">
                <span className="mw-why">
                  Usually takes
                  <button type="button" className="mw-q" aria-label="Why the time changes" aria-expanded={why} aria-controls={tip} onClick={() => setWhy((v) => !v)}>
                    ?
                  </button>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const maker = pickOf(providers, row.scope);
              const review = reviewOf(providers, row.scope);
              return (
                <tr key={row.scope}>
                  <th scope="row">
                    <span className="mw-for" title={row.format?.about ?? row.format?.blurb}>
                      {row.format ? (
                        <FormatTile id={row.format.id} formats={[row.format]} size="sm" />
                      ) : (
                        <span className="mw-chat" aria-hidden="true">
                          <Icon name="chat" />
                        </span>
                      )}
                      <span className="mw-two">
                        <b>{rowName(row)}</b>
                        {row.format && !row.format.ready && <span className="warn">{row.format.problem ?? "Not switched on in this engine yet."}</span>}
                      </span>
                    </span>
                  </th>
                  <td>
                    {hasMaker(row) ? (
                      <button type="button" className="mw-cell" disabled={!canPick} aria-label={`Made by, ${rowName(row)}`} onClick={() => setOpen({ kind: "maker", row })}>
                        {maker ? (
                          <Who pick={maker} turnKind={turnKindOf(row.format, "maker")} />
                        ) : (
                          <span className="mw-two muted">
                            <b>Not picked</b>
                            <span>pick one</span>
                          </span>
                        )}
                      </button>
                    ) : (
                      <span className="mw-dash">—</span>
                    )}
                  </td>
                  <td>
                    {!row.format ? (
                      <span className="mw-not">Not for the chat</span>
                    ) : hasReviewer(row) ? (
                      <button type="button" className="mw-cell" disabled={!canPick} aria-label={`Reviewed by, ${rowName(row)}`} onClick={() => setOpen({ kind: "reviewer", row })}>
                        {review.kind === "off" ? (
                          <span className="mw-two muted">
                            <b>None</b>
                            <span>add one</span>
                          </span>
                        ) : review.kind === "own" ? (
                          <Who pick={review.pick} turnKind={turnKindOf(row.format, "reviewer")} />
                        ) : (
                          <span className="mw-two">
                            <b>Same as the maker</b>
                            <span>change it</span>
                          </span>
                        )}
                      </button>
                    ) : (
                      <span className="mw-dash">—</span>
                    )}
                  </td>
                  <td>{row.format?.voiced ? <VoiceCell voice={voice} label={rowName(row)} onOpen={(anchor) => setOpen({ kind: "voice", anchor })} /> : <span className="mw-dash">—</span>}</td>
                  <td>
                    <Time words={rowTime(row, providers, times)} row={row} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </>
      )}
      {loadState === "ready" && why && (
        <div className="mw-tip" id={tip} role="note">
          <b>Why the time changes</b>
          <p>
            It comes from things you made on this computer with the same agent, model and effort, and for shapes with a length the same length. Pick another model or effort
            and the time changes with it. A pick that has never run shows "no time yet" instead of a guess.
          </p>
        </div>
      )}
      {error !== undefined && <p className="setnote err">{errorText(error)}</p>}
      <MakerDialogs makers={makers} />
    </section>
  );
}

/** One line on a row, for the phone's list: "Z Mid · medium · reviewed · about 4 min", or what it needs. */
function rowSummary(row: MakerRow, makers: ReturnType<typeof useMakers>): { text: string; warn?: boolean } {
  const { providers, times, voice } = makers;
  if (row.format?.voiced && voice.data && !voice.data.service) return { text: "Needs a voice", warn: true };
  if (row.format && !row.format.ready) return { text: row.format.problem ?? "Not switched on in this engine yet.", warn: true };
  const maker = pickOf(providers, row.scope);
  if (!maker) return { text: hasMaker(row) ? "Not picked" : "Made without an agent" };
  const w = pickWords(providers?.providers ?? [], maker, turnKindOf(row.format, "maker"));
  const effort = w.sub.split(" · ")[1];
  const reviewed = hasReviewer(row) && reviewOf(providers, row.scope).kind !== "off" ? "reviewed" : undefined;
  const time = rowTime(row, providers, times);
  return { text: [w.title, effort, reviewed, time && !time.muted ? time.text : undefined].filter(Boolean).join(" · ") };
}

/** The phone's What makes what: one row per scope with its line, each opening its choices. */
export function MakersPhoneList() {
  const heading = useId();
  const makers = useMakers();
  const { providers, rows, setOpen, error, canPick, loadState, retry } = makers;
  return (
    <section className="sxp-group" aria-labelledby={heading}>
      <div className="sxp-gh">
        <h2 id={heading}>What makes what</h2>
        <button type="button" className="sxp-all" disabled={!canPick} onClick={() => setOpen({ kind: "all" })}>
          Use one for all
        </button>
      </div>
      {loadState !== "ready" ? (
        <LoadState state={loadState} onRetry={retry} />
      ) : (
      <ul className="sxp-list">
        {rows.map((row) => {
          const line = rowSummary(row, makers);
          const maker = pickOf(providers, row.scope);
          const provider = providers?.providers.find((p) => p.id === maker?.agent);
          return (
            <li key={row.scope}>
              <button type="button" className="sxp-row" onClick={() => setOpen({ kind: "row", row })}>
                {row.format ? (
                  <FormatTile id={row.format.id} formats={[row.format]} size="sm" />
                ) : (
                  <span className="mw-chat" aria-hidden="true">
                    <Icon name="chat" />
                  </span>
                )}
                <span className="mw-two">
                  <b>{rowName(row)}</b>
                  <span className={line.warn ? "warn" : ""}>
                    {provider && !line.warn && <ProviderMark mark={provider.mark} label={provider.label} size={12} />}
                    {line.text}
                  </span>
                </span>
                <Icon name="chev-r" className="ico sxp-chev" />
              </button>
            </li>
          );
        })}
      </ul>
      )}
      {error !== undefined && <p className="setnote err">{errorText(error)}</p>}
      <MakerDialogs makers={makers} />
    </section>
  );
}

/** On a phone, a row's choices: Made by, Reviewed by and Voice, each opening its own picker. */
function RowSheet({ makers, row }: { makers: ReturnType<typeof useMakers>; row: MakerRow }) {
  const { providers, voice, setOpen, times, canPick } = makers;
  const maker = pickOf(providers, row.scope);
  const review = reviewOf(providers, row.scope);
  const list = providers?.providers ?? [];
  const close = () => setOpen(null);
  const markOf = (pick: MakerPick) => {
    const p = list.find((x) => x.id === pick.agent);
    return p ? <ProviderMark mark={p.mark} label={p.label} size={16} /> : undefined;
  };
  const time = rowTime(row, providers, times);
  const words = voiceWords(voice.data);
  return (
    <Picker title={rowName(row)} onClose={close} primary={{ label: "Done", onClick: close }}>
      <div className="sxp-box">
        {hasMaker(row) && (
          <PickRow
            mark={maker ? markOf(maker) : undefined}
            title={maker ? `Made by ${pickWords(list, maker, turnKindOf(row.format, "maker")).title}` : "Made by: not picked"}
            {...(maker ? { sub: pickWords(list, maker, turnKindOf(row.format, "maker")).sub } : {})}
            {...(canPick ? { onClick: () => setOpen({ kind: "maker", row }) } : {})}
          />
        )}
        {hasReviewer(row) && (
          <PickRow
            {...(review.kind === "own" ? { mark: markOf(review.pick) } : {})}
            title={review.kind === "off" ? "Reviewed by: none" : review.kind === "own" ? `Reviewed by ${pickWords(list, review.pick, turnKindOf(row.format, "reviewer")).title}` : "Reviewed by the same as the maker"}
            {...(review.kind === "own" ? { sub: pickWords(list, review.pick, turnKindOf(row.format, "reviewer")).sub } : {})}
            {...(canPick ? { onClick: () => setOpen({ kind: "reviewer", row }) } : {})}
          />
        )}
        {row.format?.voiced && (
          <PickRow
            title={words ? `Voice: ${words.title}` : "Voice: not set up"}
            sub={words ? words.sub : "Set up voice"}
            onClick={() => setOpen({ kind: "voice", anchor: null })}
          />
        )}
        {time && <p className="setnote">Usually takes {time.text}{time.sub ? `, ${time.sub}` : ""}.</p>}
      </div>
    </Picker>
  );
}
