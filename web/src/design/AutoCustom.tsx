import { useState } from "react";
import { Segmented } from "./ui";

export interface AutoCustomProps {
  /** What it sets, for screen readers: "Length", "Cards". */
  label: string;
  /** null is Auto: the sources decide, and no number shows. */
  value: number | null;
  onChange: (next: number | null) => void;
  min: number;
  max: number;
  step?: number;
  /** The word after the number: "min", "cards". */
  unit: string;
  /** The number Custom starts from the first time; the lowest allowed if left out. */
  start?: number;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** Auto | Custom. Auto shows no number; Custom shows − number +, within min and max. */
export function AutoCustom({ label, value, onChange, min, max, step = 1, unit, start }: AutoCustomProps) {
  const [last, setLast] = useState(() => clamp(value ?? start ?? min, min, max));
  const set = (n: number) => {
    const next = clamp(n, min, max);
    setLast(next);
    onChange(next);
  };
  return (
    <div className="autocustom">
      <div className="autocustom-mode">
        <Segmented
          label={label}
          options={[
            { value: "auto", label: "Auto" },
            { value: "custom", label: "Custom" },
          ]}
          value={value === null ? "auto" : "custom"}
          onChange={(mode) => (mode === "auto" ? onChange(null) : set(last))}
        />
      </div>
      {value !== null && (
        <div className="stepper" role="group" aria-label={`${label}, ${unit}`}>
          <button type="button" aria-label="Less" disabled={value <= min} onClick={() => set(value - step)}>
            −
          </button>
          <output aria-live="polite">
            {value} {unit}
          </output>
          <button type="button" aria-label="More" disabled={value >= max} onClick={() => set(value + step)}>
            +
          </button>
        </div>
      )}
    </div>
  );
}
