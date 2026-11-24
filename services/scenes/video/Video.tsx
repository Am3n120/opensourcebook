// The main composition: renders a Timeline (schemas/project.ts). Shots are hard cuts on word times;
// captions, grain and vignette sit on top; the narration is the only audio for now.
import React, { useMemo } from "react";
import { AbsoluteFill, Audio, Img, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { Theme } from "../engine/core/types.ts";
import type { Clip, StyleFile, Timeline } from "../schemas/project.ts";
import { EngineCredits, EngineShot } from "./Engine.tsx";
import { Surface } from "../engine/style/draw.tsx";
import { type Look, sceneLook } from "./look.ts";

// Only the engine's clips are here (the photo, cut-out, receipt, title, board and stage shots of older routes are
// left out): a scene, and the end card in the scene's style.
type ShotProps = { clip: Clip; style: StyleFile; index: number; sceneFile?: string; imageCredits?: Record<string, string> };
const SHOTS: Partial<Record<Clip["type"], React.FC<ShotProps>>> = {
  engine: EngineShot,
  credits: (props) => <EngineCredits clip={props.clip} />,
};

// How captions look: over photos, white with a black outline; over an engine scene, the style's own (look.ts).
const photoLook = (t: Timeline): Look => ({ font: t.style.fonts.caption, weight: 900, size: 58, upper: true, color: "white", highlight: t.style.palette.highlight, outline: "black", stroke: 10 });

export const Caption: React.FC<{ words: { text: string; highlight: boolean }[]; look: Look }> = ({ words, look }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Each page settles in a little; one that grew from 80% read to viewers as captions changing size word to word.
  const pop = spring({ frame, fps, config: { damping: 12, stiffness: 240 } });
  const strip = look.strip;
  const pad = strip ? strip.pad * look.size : 0;
  return (
    // Low and small, so the picture stays the subject. The user preferred this to big mid-screen captions. Engine
    // scenes keep the bottom fifth clear (engine/language/build.ts), and this band sits inside it.
    <AbsoluteFill style={{ top: 1640, height: 170, alignItems: "center", justifyContent: "center", padding: "0 160px 0 90px" }}>
      <div
        style={{
          fontFamily: look.font,
          fontWeight: look.weight,
          fontSize: look.size,
          lineHeight: 1.12,
          textAlign: "center",
          textTransform: look.upper ? "uppercase" : "none",
          color: look.color,
          ...(look.stroke ? { WebkitTextStroke: `${look.stroke}px ${look.outline}`, paintOrder: "stroke fill" } : {}),
          ...(strip
            ? {
                background: strip.back,
                padding: `${pad * 0.45}px ${pad}px`,
                borderLeft: strip.rule && strip.ruleWidth ? `${strip.ruleWidth}px solid ${strip.rule}` : undefined,
                outline: strip.edge ? `3px solid ${strip.edge}` : undefined,
                borderRadius: 4,
              }
            : {}),
          transform: `rotate(${strip?.rotate ?? 0}deg) scale(${0.94 + 0.06 * pop})`,
        }}
      >
        {words.map((w, i) => (
          <span key={i} style={{ color: w.highlight ? look.highlight : look.color }}>
            {i ? " " : ""}
            {w.text}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};

// How one scene gives way to the next, in the style's own way (render.motion.cut): a dip through the page, or the page
// wiped across the frame, half before the cut and half after. A hard cut draws nothing.
export const Between: React.FC<{ theme: Theme; kind: string; frames: number; width: number; height: number }> = ({ theme, kind, frames, width, height }) => {
  const frame = useCurrentFrame();
  const half = frames / 2;
  const t = frame / Math.max(1, frames); // 0 to 1 across the change, the cut at its middle
  const page = theme.colors.paper!;
  const surface = theme.style ? <Surface style={theme.style} color={page} theme={theme} width={width} height={height} /> : null;
  if (kind === "dip") {
    const cover = 1 - Math.abs(frame - half) / half;
    return <AbsoluteFill style={{ backgroundColor: page, opacity: Math.max(0, Math.min(1, cover)) }}>{surface}</AbsoluteFill>;
  }
  if (kind === "wipe") {
    // The page comes in from the left until it covers the frame at the cut, then leaves to the right.
    const ease = (x: number) => x * x * (3 - 2 * x);
    const [from, to] = t < 0.5 ? [0, ease(t * 2)] : [ease((t - 0.5) * 2), 1];
    return <AbsoluteFill style={{ backgroundColor: page, clipPath: `inset(0 ${(1 - to) * 100}% 0 ${from * 100}%)` }}>{surface}</AbsoluteFill>;
  }
  return null;
};

// `scenes`: engine scenes kept out of the props, by clip, as files in the project folder (pipeline/stages/render.ts).
// `imageCredits`: source lines of real images by project path, which an engine scene shows while the image is on screen.
export const Video: React.FC<{ timeline: Timeline; scenes?: Record<string, string>; imageCredits?: Record<string, string> }> = ({ timeline: t, scenes, imageCredits }) => {
  const frame = useCurrentFrame();
  const engine = t.clips.find((c) => c.type === "engine" && c.theme);
  const look = useMemo(() => (engine ? sceneLook(engine.theme!) : photoLook(t)), [engine, t]);
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill style={{ filter: t.style.surface?.filter }}>
        {t.clips.map((c, i) => {
          const Shot = SHOTS[c.type];
          if (!Shot) throw new Error(`clip ${c.shotId}: no shot draws a ${c.type} clip here`);
          return (
            <Sequence key={c.shotId} from={c.from} durationInFrames={c.frames} layout="none">
              <AbsoluteFill>
                <Shot clip={c} style={t.style} index={i} sceneFile={scenes?.[c.shotId]} imageCredits={imageCredits} />
                {c.credit && <div style={{ position: "absolute", top: 72, right: 60, maxWidth: 760, textAlign: "right", fontFamily: t.style.fonts.body, fontSize: 24, color: "white", opacity: 0.8, textShadow: "0 1px 4px rgba(0,0,0,0.85)" }}>{c.credit}</div>}
              </AbsoluteFill>
            </Sequence>
          );
        })}
      </AbsoluteFill>
      {engine?.theme?.style && engine.theme.style.motion.cut !== "cut" &&
        t.clips.slice(1).map((c, i) => {
          const pen = engine.theme!.style!.motion;
          const before = t.clips[i]!;
          if (before.type !== "engine") return null;
          const half = Math.round(pen.cutFrames / 2);
          // Never longer than a third of either side, so a short scene is not mostly change.
          const k = Math.max(1, Math.min(half, Math.floor(before.frames / 3), Math.floor(c.frames / 3)));
          return (
            <Sequence key={`between-${c.shotId}`} from={c.from - k} durationInFrames={k * 2} layout="none">
              <Between theme={(c.theme ?? engine.theme)!} kind={pen.cut} frames={k * 2} width={t.width} height={t.height} />
            </Sequence>
          );
        })}
      {!!t.style.surface?.paper && <Img src={staticFile("paper.png")} style={{ position: "absolute", width: "100%", height: "100%", mixBlendMode: "multiply", opacity: t.style.surface.paper }} />}
      {t.captions.map((c, i) => (
        <Sequence key={i} from={c.startFrame} durationInFrames={Math.max(1, c.endFrame - c.startFrame)} layout="none">
          <Caption words={c.words} look={look} />
        </Sequence>
      ))}
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,${t.style.vignette}) 100%)` }} />
      {t.style.grain > 0 && (
        <Img
          src={staticFile("grain.png")}
          style={{ position: "absolute", width: "100%", height: "100%", mixBlendMode: "overlay", opacity: t.style.grain, transform: `translate(${(frame * 37) % 9}px, ${(frame * 53) % 7}px)` }}
        />
      )}
      {/* A silent voice leaves no audio file. */}
      {!!t.audio && <Audio src={staticFile(t.audio)} />}
    </AbsoluteFill>
  );
};
