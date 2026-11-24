import { useState } from "react";
import type { SettingOption } from "../api/types";
import { useFormats } from "../app/context";
import { Icon } from "../design/Icon";
import { previewUrl } from "../player/media";
import { Picker } from "./Picker";
import { firstSentence, styleList, styleOf } from "./styles";
import "./make.css";

export interface StylePickerProps {
  value: string | null;
  onChange(id: string): void;
  onClose(): void;
  /** The shape whose styles to show; the first with picture styles when left out. */
  format?: string;
}

/** A style's picture, or a plain dashed tile for one without (the maker's own pick) or whose picture does not load. */
export function StyleThumb({ option, className = "st-thumb" }: { option: SettingOption | undefined; className?: string }) {
  const [broken, setBroken] = useState(false);
  const src = previewUrl(option?.preview);
  if (!src || broken) {
    return (
      <span className={`${className} none`} aria-hidden="true">
        <Icon name="sparkle" />
      </span>
    );
  }
  // The box keeps its final size while the picture is on its way, so nothing moves when it lands.
  return (
    <span className={`${className} pic`} aria-hidden="true">
      <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
    </span>
  );
}

/** One style's card: its picture, name and first sentence, with More for the rest. */
function StyleCard({ option, on, onPick }: { option: SettingOption; on: boolean; onPick: () => void }) {
  const [whole, setWhole] = useState(false);
  const said = option.description ? firstSentence(option.description) : undefined;
  return (
    <div className={`st-card${on ? " on" : ""}`}>
      <button type="button" role="radio" aria-checked={on} className="st-pick" onClick={onPick}>
        <StyleThumb option={option} />
        <b>{option.label}</b>
        {said && <span className={`st-say${whole ? " whole" : ""}`}>{whole ? option.description : said.first}</span>}
      </button>
      {said?.more && (
        <button type="button" className="st-more" aria-expanded={whole} aria-label={`${whole ? "Less" : "More"} about ${option.label}`} onClick={() => setWhole(!whole)}>
          {whole ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

/** Picks a video style by its picture, from the styles the engine serves. */
export function StylePicker({ value, onChange, onClose, format }: StylePickerProps) {
  const list = styleList(useFormats(), format);
  // Until the person picks one: the value's style, or the shape's default.
  const [picked, setDraft] = useState<string>();
  // The pick it opened on comes first; the rest keep the engine's order. Set once, so a card never moves while choosing.
  const [first, setFirst] = useState<string | null>();
  if (first === undefined && list) setFirst(styleOf(list, value)?.value ?? null);
  if (!list) {
    return (
      <Picker title="Pick a style" onClose={onClose} primary={{ label: "Use it", disabled: true, onClick: () => undefined }}>
        <p className="mk-empty">No styles are offered on this computer now.</p>
      </Picker>
    );
  }
  const draft = picked ?? styleOf(list, value)?.value;
  const chosen = list.options.find((o) => o.value === draft);
  const cards = [...list.options.filter((o) => o.value === first), ...list.options.filter((o) => o.value !== first)];
  return (
    <Picker
      className="style-picker"
      title={`Pick a style for this ${list.format.singular ?? list.format.label}`}
      onClose={onClose}
      footNote="These are the styles the maker offers today. A new style shows up here when its file is added."
      primary={{
        label: chosen ? `Use ${chosen.label}` : "Use it",
        disabled: !chosen,
        onClick: () => {
          if (!chosen) return;
          onChange(chosen.value);
          onClose();
        },
      }}
    >
      <div className="st-grid" role="radiogroup" aria-label={list.field.label}>
        {cards.map((o) => (
          <StyleCard key={o.value} option={o} on={o.value === draft} onPick={() => setDraft(o.value)} />
        ))}
      </div>
    </Picker>
  );
}
