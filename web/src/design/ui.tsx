import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";
import { Mark } from "./Mark";

/** The mark and the name; `markOnly` leaves the name to the link around it (inside a project, on a phone). */
export function Logo({ markOnly = false }: { markOnly?: boolean }) {
  return (
    <span className="logo">
      <Mark />
      {!markOnly && <span className="logo-word">Open Sourcebook</span>}
    </span>
  );
}

/** A thin progress bar; `value` is 0 to 1. */
export function Bar({ value, label, fill }: { value: number; label: string; fill?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className="bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      style={fill ? ({ "--bar-fill": fill } as CSSProperties) : undefined}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A checkbox. */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  mixed,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Some but not all: drawn as a dash, announced as mixed; a click ticks all. */
  mixed?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      className={`cbx${mixed ? " mixed" : ""}`}
      aria-checked={mixed ? "mixed" : checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {checked && !mixed && <Icon name="check" />}
    </button>
  );
}

/** An on/off switch, for a setting that takes effect at once. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

/** A segmented control. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}
