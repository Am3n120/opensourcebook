import { useId, useState } from "react";
import type { FormatDescriptor, Json, JsonObject, SettingField } from "../api/types";
import { AutoCustom } from "../design/AutoCustom";
import { Segmented } from "../design/ui";
import { fieldValue, setField, visibleFields } from "../plan/planModel";
import { StyleRow } from "./StyleRow";
import "./sheet.css";

type NumberField = SettingField & { kind: "number" };

export interface ShapeSettingsProps {
  format: FormatDescriptor;
  settings: JsonObject;
  onChange(next: JsonObject): void;
}

/**
 * The settings of one shape, drawn from its descriptor alone: the make sheet
 * and a plan item show the same thing. Who makes it is the Made by box's,
 * so agent fields are left out here. Nothing here knows a shape.
 */
export function ShapeSettings({ format, settings, onChange }: ShapeSettingsProps) {
  const fields = visibleFields(format, settings).filter((f) => f.kind !== "agent");
  if (fields.length === 0) return null;
  const set = (key: string, value: Json | undefined) => onChange(setField(format, settings, key, value));
  return (
    <div className="ss">
      {fields.map((field) => (
        <Field key={field.key} format={format} field={field} value={fieldValue(format, settings, field.key)} onChange={(v) => set(field.key, v)} />
      ))}
    </div>
  );
}

/** How a number is drawn: Auto | Custom when its zero lets the sources decide, off/on when its zero means no limit, else a stepper. */
function numberMode(field: NumberField): { mode: "auto" | "limit" | "plain"; zero?: { value: number; label: string; description?: string } } {
  const zero = field.specialValues?.find((v) => v.value === (field.min ?? 0));
  if (!zero) return { mode: "plain" };
  return { mode: (zero.means ? zero.means === "none" : meansNoLimit(zero.label)) ? "limit" : "auto", zero };
}

/**
 * Whether a special value turns the thing off rather than leaving it to the
 * sources, for an engine that does not say what the value means: read from
 * the value's own words ("No time limit"). An engine that sends `means` is
 * believed, and this is not asked.
 */
function meansNoLimit(label: string): boolean {
  return /^no\b/i.test(label.trim());
}

/** The most options a switch holds; a choice with more is a list to pick from. */
const SWITCH_MOST = 4;

/** A word or two, with a ratio or other note in brackets beside it ("Portrait (9:16)"): short enough for one part of a switch. */
function shortLabel(label: string): boolean {
  const words = label.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.length <= 2 && label.length <= 18;
}

/** A choice drawn as a switch with a part per option: up to four short options, with the engine's own words. */
function isSwitch(field: SettingField & { kind: "choice" }): boolean {
  return field.options.length <= SWITCH_MOST && !field.options.some((o) => o.preview) && field.options.every((o) => shortLabel(o.label));
}

/**
 * Wide fields take the whole row; two short ones share a row where there is
 * room (one column on a phone). Short is a number in any of its looks, a list
 * to pick from and a toggle; a switch of several parts, chips, text and
 * pictures are wide. Read from each field's kind alone, never from a shape.
 */
function isWide(field: SettingField): boolean {
  if (field.kind === "number" || field.kind === "toggle") return false;
  if (field.kind === "choice") return isSwitch(field) || field.options.some((o) => o.preview);
  return true;
}

function Field({ format, field, value, onChange }: { format: FormatDescriptor; field: SettingField; value: Json | undefined; onChange: (v: Json | undefined) => void }) {
  const id = useId();
  const labelId = `${id}-label`;
  let control: React.ReactNode;
  let help = field.help;
  switch (field.kind) {
    case "number": {
      const { mode, zero } = numberMode(field);
      const n = typeof value === "number" ? value : undefined;
      const step = field.step ?? 1;
      const min = field.min ?? 0;
      const max = field.max ?? Number.MAX_SAFE_INTEGER;
      const unit = field.unit ?? field.label.toLowerCase();
      if (mode === "auto" && zero) {
        control = (
          <AutoCustom label={field.label} value={n === undefined || n === zero.value ? null : n} onChange={(v) => onChange(v ?? zero.value)} min={Math.max(min, zero.value + step)} max={max} step={step} unit={unit} />
        );
      } else if (mode === "limit" && zero) {
        if (n === undefined || n === zero.value) help = zero.description ?? help;
        control = <Limit label={field.label} zero={zero} value={n} min={Math.max(min, zero.value + step)} max={max} step={step} unit={field.unit} onChange={onChange} />;
      } else {
        control = <Stepper label={field.label} value={n ?? min} min={min} max={max} step={step} unit={field.unit} onChange={onChange} />;
      }
      break;
    }
    case "choice": {
      const picked = typeof value === "string" ? value : undefined;
      if (field.options.some((o) => o.preview)) {
        control = <StyleRow value={picked ?? null} format={format.id} onChange={onChange} />;
      } else if (isSwitch(field)) {
        control = <Segmented label={field.label} options={field.options.map((o) => ({ value: o.value, label: o.label }))} value={picked ?? ""} onChange={onChange} />;
      } else {
        control = (
          <select className="ipt" aria-labelledby={labelId} value={picked ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
            {picked === undefined && <option value="">Default</option>}
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      }
      break;
    }
    case "choices": {
      const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      const min = Math.max(field.minItems ?? 0, 0);
      const max = field.maxItems;
      control = (
        <div className="chips" role="group" aria-labelledby={labelId}>
          {field.options.map((o) => {
            const on = list.includes(o.value);
            const locked = on ? list.length <= min : max !== undefined && list.length >= max;
            return (
              <button
                key={o.value}
                type="button"
                className={`chip${on ? " on" : ""}`}
                aria-pressed={on}
                disabled={locked}
                title={o.description}
                onClick={() => onChange(on ? list.filter((v) => v !== o.value) : field.options.map((x) => x.value).filter((v) => v === o.value || list.includes(v)))}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
      break;
    }
    case "toggle":
      control = <Segmented label={field.label} options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]} value={value === true ? "on" : "off"} onChange={(v) => onChange(v === "on")} />;
      break;
    case "text":
      control = <textarea className="ipt" rows={2} aria-labelledby={labelId} maxLength={field.maxLength} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />;
      break;
    case "textList": {
      const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      control = (
        <textarea
          className="ipt"
          rows={3}
          aria-labelledby={labelId}
          placeholder="One per line"
          value={list.join("\n")}
          onChange={(e) => {
            const lines = e.target.value.split("\n").map((l) => (field.maxLength ? l.slice(0, field.maxLength) : l));
            const kept = field.maxItems ? lines.slice(0, field.maxItems) : lines;
            onChange(kept.some((l) => l.trim()) ? kept : undefined);
          }}
        />
      );
      break;
    }
    default:
      return null;
  }
  return (
    <div className={`ss-field${isWide(field) ? " wide" : ""}`}>
      <span className="ss-lbl" id={labelId}>
        {field.label}
      </span>
      {control}
      {help && <small className="ss-help">{help}</small>}
    </div>
  );
}

/** "%" and other signs sit against the number; a word unit gets a space. */
function withUnit(n: number, unit: string | undefined): string {
  if (!unit) return String(n);
  return /^[^\p{L}\p{N}]/u.test(unit) ? `${n}${unit}` : `${n} ${unit}`;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
/** Steps of 0.5 stay exact. */
const tidy = (n: number) => Math.round(n * 1000) / 1000;

function Stepper({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label="Less" disabled={value <= min} onClick={() => onChange(clamp(tidy(value - step), min, max))}>
        −
      </button>
      <output aria-live="polite">{withUnit(value, unit)}</output>
      <button type="button" aria-label="More" disabled={value >= max} onClick={() => onChange(clamp(tidy(value + step), min, max))}>
        +
      </button>
    </div>
  );
}

/** A number whose zero is "none" (no time limit): Off holds the zero, On shows − number +. */
function Limit({
  label,
  zero,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  zero: { value: number; label: string };
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  const on = value !== undefined && value !== zero.value;
  const [last, setLast] = useState(() => (on ? value : min));
  const set = (n: number) => {
    setLast(n);
    onChange(n);
  };
  return (
    <div className="autocustom">
      <div className="autocustom-mode">
        <Segmented
          label={label}
          options={[
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
          ]}
          value={on ? "on" : "off"}
          onChange={(m) => (m === "off" ? onChange(zero.value) : set(last))}
        />
      </div>
      {on ? <Stepper label={`${label}, ${unit ?? ""}`.replace(/, $/, "")} value={value} min={min} max={max} step={step} unit={unit} onChange={set} /> : <span className="ss-off">{zero.label}</span>}
    </div>
  );
}
