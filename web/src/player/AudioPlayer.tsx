import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "../design/Icon";
import { ProgressLine } from "./chrome";
import { asAudio, clock, wordAt, type AudioPart } from "./audioData";
import { numberCites } from "./blockData";
import { CiteMarks, type OpenCite } from "./CiteMarks";
import { mediaUrl } from "./media";
import type { PlayerProps } from "./players";
import { isNumber, progressField } from "./progress";
import { useChrome } from "./useChrome";
import "./audio.css";

/** The speeds the speed button steps through, in order. */
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75] as const;
const SPEED_KEY = "opensourcebook.audio.speed";
const JUMP = 15;
// After the person scrolls the transcript by hand, it is left where they put it for this long.
const HANDS_OFF_MS = 4000;

/** One word in speaking order across all parts, with where it sits. */
interface At {
  part: number;
  word: number;
  sentence: number;
  startMs: number;
  endMs: number;
}

/**
 * Audio (engine/docs/audio.md, "Players"): a spoken walk-through with no
 * picture. The words fill the screen, each part under "Part N of M", the
 * sentence being said bright and its word marked, scrolling with it; a
 * sentence played from when chosen; each part's cites one step away; what
 * the maker added beyond the sources set apart as background. Under them:
 * the time, back and forward 15 seconds, play and pause, and speed. The
 * chrome's line along the bottom shows and moves the time, broken where the
 * parts begin (its own line, outside a chrome). The time is kept as the
 * item's progress, and the media session carries the title and controls
 * while the screen is locked, as far as a page can. In a feed it starts only
 * when played; scrolled away it pauses.
 */
export function AudioPlayer({ output, sources, complete, active = true, onOpenCite, progress, keep, here, aboutHere }: PlayerProps) {
  const audio = useMemo(() => asAudio(output.payload), [output.payload]);
  const title = audio.title || output.title;
  const src = audio.file ? mediaUrl(audio.file.url) : undefined;
  const names = useMemo(() => new Map(sources.map((s) => [s.id, s.name])), [sources]);
  const el = useRef<HTMLAudioElement>(null);
  const script = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ at: 0, length: (audio.file?.durationMs ?? 0) / 1000 });
  const [speed, setSpeed] = useState(readSpeed);
  const [now, setNow] = useState(-1);

  // Every word in order, so the one being said is found by time.
  const flat = useMemo(() => {
    const all: At[] = [];
    audio.parts.forEach((p, part) =>
      p.sentences.forEach((s, sentence) => {
        for (let word = s.from; word < s.to; word++) all.push({ part, word, sentence, startMs: p.words[word]!.startMs, endMs: p.words[word]!.endMs });
      }),
    );
    return all.sort((a, b) => a.startMs - b.startMs);
  }, [audio]);
  const flatRef = useRef(flat);
  useEffect(() => {
    flatRef.current = flat;
  }, [flat]);

  // Marks the word at the time the file is at: the last one started, unless a long quiet has passed since it ended.
  const mark = useCallback(() => {
    const a = el.current;
    if (!a) return;
    const i = wordAt(flatRef.current, a.currentTime * 1000);
    setNow(i);
  }, []);

  // Where the person stopped, kept when they pause, scroll away, every so often while it plays, and at the end.
  const keptAt = useRef(progressField(progress, "time", isNumber) ?? 0);
  const keepTime = useCallback(
    (at: number) => {
      const t = Math.round(at * 10) / 10;
      if (Math.abs(t - keptAt.current) < 0.5) return;
      keptAt.current = t;
      keep?.({ time: t });
    },
    [keep],
  );

  // Where the person is right now, finer than what is kept, so a thread is written at the spot they hear.
  const told = useRef(-1);
  const tell = useCallback(
    (at: number) => {
      const t = Math.round(at * 10) / 10;
      if (Math.abs(t - told.current) < 0.25) return;
      told.current = t;
      here?.({ time: t });
    },
    [here],
  );

  const play = useCallback(() => {
    const a = el.current;
    if (a) void Promise.resolve(a.play()).catch(() => undefined);
  }, []);
  const toggle = useCallback(() => {
    const a = el.current;
    if (!a) return;
    if (a.paused) play();
    else a.pause();
  }, [play]);
  const seek = useCallback(
    (seconds: number) => {
      const a = el.current;
      if (!a) return;
      const end = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : Infinity;
      a.currentTime = Math.max(0, Math.min(end, seconds));
      setTime({ at: a.currentTime, length: Number.isFinite(a.duration) ? a.duration : 0 });
      mark();
    },
    [mark],
  );
  const jump = useCallback((by: number) => seek((el.current?.currentTime ?? 0) + by), [seek]);
  // Tapping a sentence plays from its first word.
  const playFrom = useCallback(
    (ms: number) => {
      seek(ms / 1000);
      play();
    },
    [seek, play],
  );

  function cycleSpeed() {
    const nextSpeed = SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]!;
    setSpeed(nextSpeed);
    try {
      localStorage.setItem(SPEED_KEY, String(nextSpeed));
    } catch {
      // Storage blocked: the speed holds for this visit only.
    }
  }
  useEffect(() => {
    const a = el.current;
    if (!a) return;
    a.defaultPlaybackRate = speed;
    a.playbackRate = speed;
  }, [speed]);

  // The word mark follows the voice smoothly while it plays, frame by frame.
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame !== "function") return;
    let frame = requestAnimationFrame(function step() {
      mark();
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, mark]);

  // A screen scrolled away stops and keeps its time, so two never play at once. A feed's autoplay is not followed: audio starts on a tap.
  useEffect(() => {
    const a = el.current;
    if (active || !a) return;
    a.pause();
    if (!a.ended && a.currentTime > 0) keepTime(a.currentTime);
  }, [active, keepTime]);

  // The transcript keeps the sentence being said in view, unless the person scrolled it by hand a moment ago.
  const handsAt = useRef(0);
  const cur = flat[now];
  const curKey = cur ? `${cur.part}-${cur.sentence}` : "";
  useEffect(() => {
    const box = script.current;
    if (!curKey || !playing || !box || Date.now() - handsAt.current < HANDS_OFF_MS) return;
    const s = box.querySelector<HTMLElement>(`[data-s="${curKey}"]`);
    if (!s) return;
    const r = s.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top >= b.top + b.height * 0.15 && r.bottom <= b.bottom - b.height * 0.25) return;
    box.scrollTo?.({ top: box.scrollTop + (r.top - b.top) - b.height * 0.3, behavior: "smooth" });
  }, [curKey, playing]);
  const byHand = () => {
    handsAt.current = Date.now();
  };

  // Keys while this one is in view: Space plays and pauses, ← → move 15 seconds; ↑ ↓ are the chrome's, to the thing before and after.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t?.closest("input, textarea, select")) return;
      const onButton = !!t?.closest("button, a, [role=button]");
      if (e.key === " " && src && !onButton) toggle();
      else if (e.key === "ArrowLeft" && src && !onButton) jump(-JUMP);
      else if (e.key === "ArrowRight" && src && !onButton) jump(JUMP);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, src, toggle, jump]);

  // The lock screen and headset buttons, where the browser offers them; only the screen in view takes them.
  const partNow = cur?.part ?? 0;
  const partsRef = useRef(audio.parts);
  useEffect(() => {
    partsRef.current = audio.parts;
  }, [audio.parts]);
  useEffect(() => {
    const ms = mediaSession();
    if (!ms || !active || !src) return;
    const toPart = (dir: -1 | 1) => {
      const a = el.current;
      const parts = partsRef.current;
      if (!a || parts.length === 0) return;
      const t = a.currentTime * 1000;
      let i = 0;
      parts.forEach((p, n) => {
        if (p.startMs <= t + 1) i = n;
      });
      // Back within the first few seconds of a part goes to the one before; later, to this part's start.
      const target = dir === 1 ? i + 1 : t - parts[i]!.startMs > 3000 ? i : i - 1;
      if (target >= 0 && target < parts.length) seek(parts[target]!.startMs / 1000);
    };
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => play()],
      ["pause", () => el.current?.pause()],
      ["seekbackward", (d) => jump(-(d.seekOffset ?? JUMP))],
      ["seekforward", (d) => jump(d.seekOffset ?? JUMP)],
      ["seekto", (d) => d.seekTime !== undefined && seek(d.seekTime)],
      ["previoustrack", () => toPart(-1)],
      ["nexttrack", () => toPart(1)],
    ];
    for (const [action, handler] of handlers) setHandler(ms, action, handler);
    return () => {
      for (const [action] of handlers) setHandler(ms, action, null);
    };
  }, [active, src, play, jump, seek]);
  const partTitle = audio.parts[partNow]?.title ?? "";
  useEffect(() => {
    const ms = mediaSession();
    if (!ms || !active || !src || typeof MediaMetadata === "undefined") return;
    try {
      ms.metadata = new MediaMetadata({ title, artist: "Open Sourcebook", album: partTitle });
    } catch {
      // A browser that refuses the metadata still plays.
    }
  }, [active, src, title, partTitle]);
  const position = useCallback(() => {
    const ms = mediaSession();
    const a = el.current;
    if (!ms || !active || !a || !Number.isFinite(a.duration) || a.duration <= 0) return;
    try {
      ms.setPositionState?.({ duration: a.duration, playbackRate: a.playbackRate || 1, position: Math.min(a.currentTime, a.duration) });
    } catch {
      // Position is a nicety; a browser that rejects it still plays.
    }
  }, [active]);

  const at = Math.round(time.at * 10) / 10;
  // The line along the bottom: the time, broken where each part begins.
  const length = time.length || (audio.file?.durationMs ?? 0) / 1000;
  const through = length ? Math.min(1, time.at / length) : 0;
  const marks = useMemo(() => (length ? audio.parts.map((p) => p.startMs / 1000 / length) : []), [audio.parts, length]);
  const seekTo = useCallback((fraction: number) => seek(fraction * length), [seek, length]);
  const inChrome = useChrome({ behind: "themed", ...(src ? { progress: through, marks, onSeek: seekTo } : {}) });
  return (
    <div className="astage">
      <div className="ascript" ref={script} aria-label={`Words of ${title}`} onWheel={byHand} onTouchMove={byHand} onPointerDown={byHand}>
        {audio.lengthNote && <p className="anote">{audio.lengthNote}</p>}
        {audio.parts.map((p, i) => (
          <Part key={p.id} part={p} index={i} of={audio.parts.length} word={cur && cur.part === i ? cur.word : -1} names={names} onOpenCite={onOpenCite} onPlayFrom={src ? playFrom : undefined} />
        ))}
        {aboutHere && <div className="aabout">{aboutHere({ time: at })}</div>}
      </div>
      {src ? (
        <div className="actrl">
          <audio
            ref={el}
            src={src}
            preload="metadata"
            aria-label={title}
            onPlay={() => {
              setPlaying(true);
              const ms = mediaSession();
              if (ms && active) ms.playbackState = "playing";
              position();
            }}
            onPause={(e) => {
              setPlaying(false);
              const ms = mediaSession();
              if (ms && active) ms.playbackState = "paused";
              if (!e.currentTarget.ended) keepTime(e.currentTarget.currentTime);
            }}
            onLoadedMetadata={(e) => {
              const a = e.currentTarget;
              a.defaultPlaybackRate = speed;
              a.playbackRate = speed;
              // Carry on from where the person stopped, unless that was the very end.
              if (keptAt.current > 0 && a.duration && keptAt.current < a.duration - 1) a.currentTime = keptAt.current;
              setTime({ at: a.currentTime, length: Number.isFinite(a.duration) ? a.duration : 0 });
              mark();
              position();
            }}
            onTimeUpdate={(e) => {
              const a = e.currentTarget;
              setTime({ at: a.currentTime, length: Number.isFinite(a.duration) ? a.duration : time.length });
              mark();
              tell(a.currentTime);
              if (!a.paused && Math.abs(a.currentTime - keptAt.current) >= 10) keepTime(a.currentTime);
            }}
            onSeeked={() => {
              mark();
              position();
            }}
            onRateChange={position}
            onEnded={() => {
              setPlaying(false);
              keepTime(0);
              complete?.();
            }}
          />
          <span className="aclock" aria-label={`${clock(time.at)} of ${clock(length)}`}>
            {clock(time.at)}
          </span>
          <button type="button" className="abtn" aria-label="Back 15 seconds" title="Back 15 seconds" onClick={() => jump(-JUMP)}>
            <Icon name="retry" />
          </button>
          <button type="button" className="aplay" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
            <Icon name={playing ? "pause" : "play"} />
          </button>
          <button type="button" className="abtn afwd" aria-label="Forward 15 seconds" title="Forward 15 seconds" onClick={() => jump(JUMP)}>
            <Icon name="retry" />
          </button>
          <button type="button" className="aspeed" aria-label={`Speed: ${speedLabel(speed)}`} title="Speed" onClick={cycleSpeed}>
            {speedLabel(speed)}
          </button>
        </div>
      ) : (
        <p className="vnone anone">This audio has no file yet.</p>
      )}
      {src && !inChrome && <ProgressLine progress={through} marks={marks} onSeek={seekTo} />}
    </div>
  );
}

/** One part of the words: "Part N of M" and its title, its sentences to play from, its cites; a background part is set apart as not from the sources. */
const Part = memo(function Part({
  part,
  index,
  of,
  word,
  names,
  onOpenCite,
  onPlayFrom,
}: {
  part: AudioPart;
  index: number;
  of: number;
  word: number;
  names: Map<string, string>;
  onOpenCite?: OpenCite | undefined;
  onPlayFrom?: ((ms: number) => void) | undefined;
}) {
  return (
    <section className={`apart${part.background ? " bg" : ""}${word >= 0 ? " now" : ""}`} aria-label={part.title || `Part ${index + 1}`}>
      {(of > 1 || part.title) && <h4>{[of > 1 ? `Part ${index + 1} of ${of}` : "", part.title].filter(Boolean).join(" · ")}</h4>}
      <p>
        {part.background && <span className="abgtag">Background, not from your sources: </span>}
        {part.sentences.map((s, si) => {
          const words = part.words.slice(s.from, s.to);
          const on = word >= s.from && word < s.to;
          const playHere = () => onPlayFrom?.(s.startMs);
          return (
            <span key={si}>
              <span
                className={`asent${on ? " on" : ""}`}
                data-s={`${index}-${si}`}
                role={onPlayFrom ? "button" : undefined}
                tabIndex={onPlayFrom ? 0 : undefined}
                title={onPlayFrom ? "Play from here" : undefined}
                onClick={onPlayFrom ? playHere : undefined}
                onKeyDown={
                  onPlayFrom
                    ? (e: ReactKeyboardEvent) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        playHere();
                      }
                    : undefined
                }
              >
                {words.map((w, wi) => {
                  const n = s.from + wi;
                  return (
                    <span key={n}>
                      {wi > 0 && " "}
                      <span className={n === word ? "aword on" : "aword"} aria-current={n === word ? "true" : undefined}>
                        {w.text}
                      </span>
                    </span>
                  );
                })}
              </span>{" "}
            </span>
          );
        })}
        <CiteMarks marks={numberCites(part.cites)} names={names} onOpen={onOpenCite} />
      </p>
    </section>
  );
});

const speedLabel = (s: number) => `${s}×`;

/** The speed this viewer chose last time, or 1. */
function readSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return (SPEEDS as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

function mediaSession(): MediaSession | undefined {
  return typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : undefined;
}

function setHandler(ms: MediaSession, action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
  try {
    ms.setActionHandler(action, handler);
  } catch {
    // An action this browser does not know is left out.
  }
}
