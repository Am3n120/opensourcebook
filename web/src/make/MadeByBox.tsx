import { useState } from "react";
import { Link } from "react-router";
import type { FormatDescriptor, JsonObject, Provider } from "../api/types";
import { useApi, useProviders } from "../app/context";
import { useLoad } from "../app/useLoad";
import { Icon } from "../design/Icon";
import { PickRow } from "../design/PickRow";
import { ProviderMark } from "../design/ProviderMark";
import { timeBucket } from "../plan/timing";
import { defaultEffortId, defaultModelId, agentField, timeKey, turnKindOf, type MakerPick } from "./makerKey";
import { timeResult, timeWords, totalWords, useMakeTimes, type MakeTimeResult } from "./makeTime";
import { VoicePicker } from "../voice/VoicePicker";
import { MakerPicker } from "./MakerPicker";
import { noAgentSetUp, rowPick, withPick } from "./madeBy";
import "./sheet.css";

export interface MadeByBoxProps {
  format: FormatDescriptor;
  settings: JsonObject;
  onChange(next: JsonObject): void;
}

/**
 * Who makes one thing, who reviews it and whose voice speaks it, each a row
 * that opens its picker, and how long it all takes here. It starts from the
 * person's defaults for the shape; a pick made here goes into this thing's
 * settings only and never becomes a default.
 */
export function MadeByBox({ format, settings, onChange }: MadeByBoxProps) {
  const { providers, status, retry } = useProviders();
  const [open, setOpen] = useState<"maker" | "reviewer">();
  const all = { ...format.defaults, ...settings };
  const bucket = timeBucket(format, all);
  // A shape that declares no maker of its own has no Made by row, nor a reviewer.
  const hasMaker = !!agentField(format, "maker");
  const hasReviewer = hasMaker && !!agentField(format, "reviewer");

  const maker = rowPick(format, settings, "maker", providers?.picks);
  const reviewer = hasReviewer ? rowPick(format, settings, "reviewer", providers?.picks) : undefined;
  // A reviewer left open with no default of its own reviews with the maker's pick, as the engine does.
  const reviewerUses = reviewer && reviewer.from === "none" ? maker.pick : (reviewer?.pick ?? null);

  const makerTimes = useMakeTimes(hasMaker ? format.id : undefined);
  const reviewTimes = useMakeTimes(hasReviewer ? `${format.id}.review` : undefined);
  const rail = providers?.providers ?? [];
  const makerRow = describe(rail, maker.pick, format, "maker", bucket, makerTimes);
  const reviewRow = reviewer ? describe(rail, reviewerUses, format, "reviewer", bucket, reviewTimes) : undefined;

  const parts: MakeTimeResult[] = [makerRow.result];
  if (reviewer && reviewerUses) parts.push(reviewRow!.result);
  const total = totalWords(parts);

  const plural = format.plural ?? `${format.label}s`;
  const allDefault = maker.from === "default" && (!reviewer || reviewer.from !== "own");
  const lengthWords = lengthOf(format, all);

  if (!hasMaker && !format.voiced) return null;
  if (hasMaker && !providers) {
    // The engine has not answered yet, or could not be reached: say that, never "pick who makes it" or a time.
    return (
      <div className="mb-box">
        <div className="mb-head">
          <h3>Made by</h3>
        </div>
        <div className="mb-none" role="status">
          <span className="mb-none-mark quiet" aria-hidden="true">
            <Icon name="sparkle" />
          </span>
          <div className="mb-none-tx">
            {status === "failed" ? <b>Couldn't reach the engine</b> : <span>Looking for your agents…</span>}
          </div>
          {status === "failed" && (
            <button type="button" className="mb-setup" onClick={retry}>
              Try again
            </button>
          )}
        </div>
        {format.voiced && <VoiceRow />}
      </div>
    );
  }
  if (hasMaker && noAgentSetUp(providers, status)) {
    // Nothing on this computer can make it: say so, with the way to set one up. The make button waits (no stand-ins).
    return (
      <div className="mb-box">
        <div className="mb-head">
          <h3>Made by</h3>
        </div>
        <div className="mb-none" role="status">
          <span className="mb-none-mark" aria-hidden="true">
            !
          </span>
          <div className="mb-none-tx">
            <b>No agent is set up yet</b>
            <span>Add the coding agent you use, signed in on this computer.</span>
          </div>
          <Link className="mb-setup" to="/settings#providers">
            Set one up
          </Link>
        </div>
        {format.voiced && <VoiceRow />}
      </div>
    );
  }
  return (
    <div className="mb-box">
      <div className="mb-head">
        <h3>Made by</h3>
        {hasMaker && allDefault && <span className="mb-tag">Your default for {plural}</span>}
      </div>
      {hasMaker && (
        <PickRow
          mark={makerRow.provider ? <ProviderMark mark={makerRow.provider.mark} label={makerRow.provider.label} size={18} /> : <Icon name="sparkle" />}
          title={makerRow.provider?.label ?? "Made by"}
          sub={makerRow.provider ? makerRow.sub : "Pick who makes it"}
          time={makerRow.words?.text}
          timeSub={makerRow.words && !makerRow.words.muted ? [lengthWords && `for ${lengthWords}`, makerRow.words.sub].filter(Boolean).join(" · ") : makerRow.words?.sub}
          timeMuted={makerRow.words?.muted}
          onClick={() => setOpen("maker")}
        />
      )}
      {reviewer && reviewRow && (
        <PickRow
          mark={reviewerUses && reviewRow.provider ? <ProviderMark mark={reviewRow.provider.mark} label={reviewRow.provider.label} size={18} /> : <Icon name="eye" />}
          title="Reviewed by"
          sub={
            reviewerUses
              ? [reviewRow.provider?.label, reviewRow.sub, reviewer.from === "none" ? "the maker's own pick" : undefined].filter(Boolean).join(" · ")
              : "None · add one if you want a second look"
          }
          time={reviewerUses ? reviewRow.words?.text : undefined}
          timeSub={reviewerUses ? reviewRow.words?.sub : undefined}
          timeMuted={reviewRow.words?.muted}
          onClick={() => setOpen("reviewer")}
        />
      )}
      {format.voiced && <VoiceRow />}
      {hasMaker && (
        <div className="mb-total" aria-live="polite">
          {total && !total.muted ? (
            <span>
              In all <b>{total.text}</b>
            </span>
          ) : (
            <span className="muted">{total ? `In all: ${total.text}` : "In all: …"}</span>
          )}
        </div>
      )}
      {open && (
        <MakerPicker
          scope={format.id}
          role={open}
          value={open === "maker" ? maker.pick : reviewerUses}
          allowNone={open === "reviewer"}
          settings={all}
          onChange={(pick) => onChange(withPick(format, settings, open, pick))}
          onClose={() => setOpen(undefined)}
        />
      )}
    </div>
  );
}

interface Described {
  provider?: Provider;
  sub?: string;
  result: MakeTimeResult;
  words?: ReturnType<typeof timeWords>;
}

/** A pick in words ("Z Mid · medium effort") and its time here. */
function describe(
  rail: readonly Provider[],
  pick: MakerPick | null,
  format: FormatDescriptor,
  role: "maker" | "reviewer",
  bucket: string | undefined,
  times: ReturnType<typeof useMakeTimes>,
): Described {
  const provider = pick ? rail.find((p) => p.id === pick.agent) : undefined;
  if (!pick || !provider) {
    // Nobody picked, or an agent no longer on this computer: nothing has run with it here.
    const result: MakeTimeResult = { status: "none" };
    return { result, words: timeWords(result) };
  }
  const turnKind = turnKindOf(format, role);
  const scope = role === "reviewer" ? `${format.id}.review` : format.id;
  const modelId = pick.model ?? defaultModelId(provider, turnKind);
  const model = provider.models.find((m) => m.id === modelId)?.label ?? modelId;
  const effortId = pick.effort ?? defaultEffortId(provider, turnKind);
  const effort = provider.efforts.find((e) => e.id === effortId)?.label;
  const sub = [model, effort && `${effort.toLowerCase()} effort`].filter(Boolean).join(" · ");
  const result = timeResult(times, timeKey(scope, provider, pick, turnKind, bucket));
  return { provider, sub, result, words: timeWords(result) };
}

/** The voice set up on this computer, or "Not set up"; either opens the picker of voice services. */
function VoiceRow() {
  const client = useApi();
  const voice = useLoad(() => client.voice(), [client]);
  const [anchor, setAnchor] = useState<HTMLElement | null>();
  const setup = voice.data;
  const service = setup?.service ? setup.services.find((s) => s.id === setup.service) : undefined;
  const ready = !!setup?.service;
  return (
    <>
      <PickRow
        mark={<Icon name="sound" />}
        title="Voice"
        sub={voice.loading && !setup ? "…" : ready ? [service?.label ?? setup?.service, setup?.voice?.label].filter(Boolean).join(" · ") : "Not set up"}
        onClick={(e) => setAnchor(e.currentTarget)}
      />
      {!voice.loading && !ready && (
        <p className="mb-voice-off">
          <Link to="/settings#voice">Set up voice</Link>
        </p>
      )}
      {anchor !== undefined && <VoicePicker anchor={anchor} {...(setup ? { setup } : {})} onChange={voice.set} onClose={() => setAnchor(undefined)} />}
    </>
  );
}

/** The length the time is for: "3 min"; none for Auto or a shape kept in one group. */
function lengthOf(format: FormatDescriptor, all: JsonObject): string | undefined {
  const timing = format.timing;
  if (!timing) return undefined;
  const field = format.settings.find((f) => f.key === timing.setting);
  const n = all[timing.setting];
  if (typeof n !== "number" || n <= 0 || field?.kind !== "number") return undefined;
  return field.unit ? `${n} ${field.unit}` : String(n);
}
