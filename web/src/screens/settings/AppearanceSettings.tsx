import { useId } from "react";
import { THEME_CHOICES, useTheme } from "../../design/theme";
import { SectionHead } from "./SectionHead";

/** Settings › Appearance: the theme, each choice drawn as a small picture of itself. */
export function AppearanceSettings() {
  const heading = useId();
  const label = useId();
  const [theme, setTheme] = useTheme();
  return (
    <section className="sx-sec" aria-labelledby={heading}>
      <SectionHead id={heading} title="Appearance" />
      <div className="card sx-card">
        <span className="sx-lbl" id={label}>
          Theme
        </span>
        <div className="sx-themes" role="radiogroup" aria-labelledby={label}>
          {THEME_CHOICES.map((c) => (
            <button key={c.value} type="button" role="radio" aria-checked={c.value === theme} className={c.value === theme ? "on" : ""} onClick={() => setTheme(c.value)}>
              <span className={`sx-swatch ${c.value}`} aria-hidden="true" />
              <b>{c.label}</b>
            </button>
          ))}
        </div>
        <p className="setnote">System follows this device's light or dark setting. Kept on this device.</p>
      </div>
    </section>
  );
}
