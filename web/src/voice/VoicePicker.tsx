import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { errorText } from "../api/errors";
import type { VoiceServiceView, VoiceSetup } from "../api/types";
import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";
import { Icon } from "../design/Icon";
import { serviceReady, setUpLink } from "./ready";
import { SAMPLE_FAILED, useSample } from "./useSample";
import "./voice-picker.css";

export interface VoicePickerProps {
  /** What was clicked; the popover sits under it, and focus goes back to it on close. */
  anchor: HTMLElement | null;
  /** The voice as the caller last read it, so the list shows at once. */
  setup?: VoiceSetup;
  /** Called with the engine's answer after a choice, so the caller's own view follows. */
  onChange(setup: VoiceSetup): void;
  onClose(): void;
}

const GAP = 6;
const WIDTH = 340;
const EDGE = 12;

/**
 * The voice services the engine lists, in its order, as a small popover
 * under what was clicked (a bottom sheet on a phone). A service that can
 * speak is picked on the spot, with its voices under it where it lists
 * them; one that cannot says so and goes to Settings to be set up. The
 * voice is one setting for the whole app, so every place that shows it
 * shows the same choice.
 */
export function VoicePicker({ anchor, setup: known, onChange, onClose }: VoicePickerProps) {
  const client = useApi();
  const load = useLoad(async () => known ?? client.voice(), [client]);
  const setup = load.data;
  const loaded = setup !== undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>();

  // Under the anchor, or above it when there is more room there; the CSS ignores this on a phone.
  useLayoutEffect(() => {
    if (!anchor) return;
    const put = () => {
      const r = anchor.getBoundingClientRect();
      const room = window.innerHeight - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      const up = room < 280 && above > room;
      const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - WIDTH - EDGE));
      setPlace({
        left,
        ...(up ? { bottom: window.innerHeight - r.top + GAP, maxHeight: above } : { top: r.bottom + GAP, maxHeight: room }),
      });
    };
    put();
    window.addEventListener("resize", put);
    window.addEventListener("scroll", put, true);
    return () => {
      window.removeEventListener("resize", put);
      window.removeEventListener("scroll", put, true);
    };
  }, [anchor]);

  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[aria-checked="true"], button:not([disabled]), a')?.focus();
    const keys = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      anchor?.focus();
    };
  }, [anchor, loaded]);

  async function choose(service: string, voice?: string) {
    setBusy(true);
    setError(undefined);
    try {
      const next = await client.setVoice(voice === undefined ? { service } : { service, voice });
      load.set(next);
      onChange(next);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="vp-layer">
      <div className="vp-scrim" aria-hidden="true" onClick={onClose} />
      <div ref={box} className="vp" role="dialog" aria-label="Voice" style={place}>
        <span className="vp-grab" aria-hidden="true" />
        <div className="vp-head">
          <b>Voice</b>
          <button type="button" className="ib vp-x" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <p className="vp-quiet">One voice speaks every video and audio.</p>
        <div className="vp-body">
          {!setup ? (
            <p className="vp-quiet vp-pad" role="status">
              {load.error !== undefined ? errorText(load.error) : "Checking…"}
            </p>
          ) : (
            <ul className="vp-list" role="radiogroup" aria-label="Voice service">
              {setup.services.map((s) => (
                <Service key={s.id} service={s} setup={setup} busy={busy} onChoose={choose} />
              ))}
            </ul>
          )}
          {error !== undefined && (
            <p className="vp-err" role="alert">
              {errorText(error)}
            </p>
          )}
        </div>
        <p className="vp-foot">
          <Link to="/settings#voice" onClick={onClose}>
            Keys and more in Settings, under Voice
          </Link>
        </p>
      </div>
    </div>,
    document.body,
  );
}

function Service({ service: s, setup, busy, onChoose }: { service: VoiceServiceView; setup: VoiceSetup; busy: boolean; onChoose: (service: string, voice?: string) => void }) {
  const on = setup.service === s.id;
  if (!serviceReady(s)) {
    return (
      <li>
        <Link className="vp-svc off" to={setUpLink(s.id)} aria-label={`${s.label}, not set up. Set up`}>
          <span className="vp-tick" aria-hidden="true" />
          <span className="vp-who">
            <b>{s.label}</b>
            <span>Not set up</span>
          </span>
          <span className="vp-setup">Set up</span>
        </Link>
      </li>
    );
  }
  return (
    <li className={on ? "on" : ""}>
      <button type="button" role="radio" aria-checked={on} className="vp-svc" disabled={busy} onClick={() => !on && onChoose(s.id)}>
        <span className="vp-tick" aria-hidden="true">
          {on && <Icon name="check" />}
        </span>
        <span className="vp-who">
          <b>{s.label}</b>
          <span>{on && setup.voice ? setup.voice.label : s.about}</span>
        </span>
      </button>
      {on && s.listsVoices && <Voices service={s} setup={setup} busy={busy} onPick={(id) => onChoose(s.id, id)} />}
    </li>
  );
}

/** The chosen service's voices, each with a sample to play and the current one ticked. */
function Voices({ service: s, setup, busy, onPick }: { service: VoiceServiceView; setup: VoiceSetup; busy: boolean; onPick: (id: string) => void }) {
  const client = useApi();
  const voices = useLoad(() => client.voiceOptions(s.id), [client, s.id, s.keySet, s.installed]);
  const { playing, failed, play } = useSample(s.id);

  if (!voices.data) {
    return (
      <p className="vp-quiet vp-sub" role="status">
        {voices.error !== undefined ? errorText(voices.error) : "Asking for your voices…"}
      </p>
    );
  }
  return (
    <ul className="vp-voices" role="radiogroup" aria-label={`${s.label} voices`}>
      {voices.data.map((v) => {
        const picked = setup.voice?.id === v.id;
        return (
          <li key={v.id} className={picked ? "on" : ""}>
            {s.samples && v.sample ? (
              <button type="button" className="ib vp-play" aria-label={`${playing === v.id ? "Stop" : "Play"} ${v.label}`} aria-pressed={playing === v.id} onClick={() => play(v.id)}>
                <Icon name={playing === v.id ? "pause" : "play"} />
              </button>
            ) : (
              <span className="vp-play" aria-hidden="true" />
            )}
            <button type="button" role="radio" aria-checked={picked} className="vp-voice" disabled={busy} onClick={() => !picked && onPick(v.id)}>
              <span className="vp-who">
                <b>{v.label}</b>
                {(v.description || v.language) && <span>{[v.description, v.language].filter(Boolean).join(" · ")}</span>}
              </span>
              {picked && <Icon name="check" />}
            </button>
            {failed === v.id && (
              <p className="vp-fail" role="status">
                {SAMPLE_FAILED}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
