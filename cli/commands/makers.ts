/** What Open Sourcebook can make on this computer, and with what: the shapes and their makers, the video styles, the agents. */
import { connect } from "./connect.ts";
import type { Group } from "./table.ts";
import { table } from "./util.ts";

interface Option {
  value: string;
  label: string;
  description?: string;
}
interface Setting {
  key: string;
  label?: string;
  kind?: string;
  options?: Option[];
}
interface Format {
  id: string;
  label: string;
  ready: boolean;
  description?: string;
  settings?: Setting[];
  defaults?: Record<string, unknown>;
}
interface VideoMaker {
  id: string;
  label: string;
  description?: string;
  available: boolean;
  problem?: string;
  /** What to know before making a video with it, though it can: no voice key, so no sound, and what to do. */
  notice?: string;
  styles?: number;
  default?: boolean;
}
interface Provider {
  id: string;
  label: string;
  state: string;
  headline?: string;
  detail?: string;
  enabled?: boolean;
  added?: boolean;
  signIn?: string;
  version?: string;
  defaultModel?: string;
}

const settingsOf = (f: Format) => (f.settings ?? []).map((s) => ({ key: s.key, label: s.label ?? s.key, ...(s.kind ? { kind: s.kind } : {}), ...(s.options ? { options: s.options.map((o) => o.value) } : {}), ...(f.defaults && s.key in f.defaults ? { default: f.defaults[s.key] } : {}) }));

export const makers: Group = {
  thing: "maker",
  aliases: ["shape", "shapes"],
  about: "the shapes Open Sourcebook makes (video, flashcards, quiz, audio, guide) and the makers behind them, ready or why not",
  commands: [
    {
      thing: "maker",
      action: "list",
      summary: "each shape, whether it can be made now, its settings, and the video makers with why one is not ready",
      shape: "{ shapes: [{ id, label, ready: boolean, settings: [{ key, label, kind?, options?, default? }] }], videoMakers: [{ id, label, description?, available: boolean, problem?, notice?, styles }] }  (notice: what to know before making a video with it, such as no sound and what to do for one)",
      async run(ctx) {
        const engine = connect(ctx);
        const [{ formats }, { makers: video }] = await Promise.all([engine.call<{ formats: Format[] }>("GET", "/v1/formats"), engine.call<{ makers: VideoMaker[] }>("GET", "/v1/video-makers")]);
        const shapes = formats.map((f) => ({ id: f.id, label: f.label, ready: f.ready, settings: settingsOf(f) }));
        const text = [
          table(shapes.map((s) => [s.id, s.ready ? "ready" : "not ready", s.settings.map((x) => x.key).join(", ")])),
          "",
          "Video makers:",
          ...video.map((m) => `  ${m.id}: ${m.available ? "ready" : `not ready: ${m.problem ?? "not set up here"}`}${m.description ? `\n    ${m.description}` : ""}${m.notice ? `\n    ${m.notice}` : ""}`),
          "",
          'Settings go on an item with "opensourcebook item change <item> --set key=value".',
        ];
        return { data: { shapes, videoMakers: video }, text: text.join("\n") };
      },
    },
  ],
};

export const styles: Group = {
  thing: "style",
  aliases: ["styles"],
  about: "the looks a video can have",
  commands: [
    {
      thing: "style",
      action: "list",
      summary: "the video styles, each with what it suits",
      shape: "{ styles: [{ id, label, description? }] }",
      async run(ctx) {
        const { formats } = await connect(ctx).call<{ formats: Format[] }>("GET", "/v1/formats");
        const options = formats.flatMap((f) => (f.settings ?? []).filter((s) => s.key === "style").flatMap((s) => s.options ?? []));
        const list = options.map((o) => ({ id: o.value, label: o.label, ...(o.description ? { description: o.description } : {}) }));
        return { data: { styles: list }, text: list.length ? `${list.map((s) => `${s.id}: ${s.label}${s.description ? `. ${s.description}` : ""}`).join("\n")}\n\nPick one with "opensourcebook item change <item> --set style=<id>".` : "No video maker with styles is ready here." };
      },
    },
  ],
};

export const agents: Group = {
  thing: "agent",
  aliases: ["agents"],
  about: "the coding agents on this computer that answer and make things inside Open Sourcebook",
  commands: [
    {
      thing: "agent",
      action: "list",
      summary: "each agent Open Sourcebook can run, whether it is ready, and what to do when it is not",
      shape: "{ connector: { reachable: boolean }, agents: [{ id, label, state: \"ready\"|\"signedOut\"|\"missing\"|\"unavailable\", headline?, detail?, signIn?, enabled? }] }",
      async run(ctx) {
        const { connector, providers } = await connect(ctx).call<{ connector: { configured: boolean; reachable: boolean }; providers: Provider[] }>("GET", "/v1/providers", { query: { fresh: 1 } });
        const list = providers.map((p) => ({ id: p.id, label: p.label, state: p.state, ...(p.headline ? { headline: p.headline } : {}), ...(p.detail ? { detail: p.detail } : {}), ...(p.signIn && p.state === "signedOut" ? { signIn: p.signIn } : {}), ...(p.enabled !== undefined ? { enabled: p.enabled } : {}), ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}) }));
        const text = connector.reachable
          ? list.map((a) => `${a.label} (${a.id}): ${a.headline ?? a.state}${a.detail ? `. ${a.detail}` : ""}${"signIn" in a ? ` Sign in with: ${a.signIn}` : ""}`).join("\n")
          : 'The agent connector is not answering, so no agent can work inside Open Sourcebook; "opensourcebook status" says more.';
        return { data: { connector: { reachable: connector.reachable }, agents: list }, text };
      },
    },
  ],
};
