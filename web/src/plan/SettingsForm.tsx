import { useContext, useRef, useState } from "react";
import type { AgentPickPatch, FormatDescriptor, JsonObject, Provider, Providers, SettingField } from "../api/types";
import { Ctx } from "../app/context";
import { previewUrl } from "../player/media";
import { ModelPicker } from "../project/ModelPicker";
import { onRail, shownChoice, shownEffort, workGuidance } from "../project/providers";
import { fieldValue, setField, specialValue, visibleFields } from "./planModel";

/** A format's settings drawn from its descriptor; nothing here knows a format. */
export function SettingsForm({
  format,
  settings,
  onChange,
  disabled,
  providers: providersProp,
  onSavePick,
}: {
  format: FormatDescriptor | undefined;
  settings: JsonObject;
  onChange: (next: JsonObject) => void;
  disabled?: boolean;
  providers?: Providers;
  onSavePick?: (scope: string, patch: AgentPickPatch) => void;
}) {
  const app = useContext(Ctx);
  const providers = providersProp ?? app?.providers;
  const savePick = onSavePick ?? app?.saveAgentPick;
  const favorite = app
    ? async (provider: Provider, favoriteModels: string[]) => {
        if (app.updateProvider) {
          await app.updateProvider(provider.id, { favoriteModels });
        } else {
          app.setProviders?.(await app.client.updateProvider(provider.id, { favoriteModels }));
        }
      }
    : undefined;
  const fields = visibleFields(format, settings);
  if (!format) return <small className="d">This format is not one the engine declares; its settings are kept as they are.</small>;
  if (fields.length === 0) return <small className="d">This format has no settings.</small>;
  return (
    <div className="grid2">
      {fields.map((field) => (
        <Field
          key={field.key}
          format={format}
          settings={settings}
          field={field}
          value={fieldValue(format, settings, field.key)}
          disabled={disabled}
          providers={providers}
          savePick={savePick}
          onFavorite={favorite}
          onChangeSettings={onChange}
          onChange={(v) => onChange(setField(format, settings, field.key, v))}
        />
      ))}
    </div>
  );
}

function Field({
  format,
  settings,
  field,
  value,
  onChange,
  onChangeSettings,
  disabled,
  providers,
  savePick,
  onFavorite,
}: {
  format: FormatDescriptor;
  settings: JsonObject;
  field: SettingField;
  value: unknown;
  onChange: (v: JsonObject[string] | undefined) => void;
  onChangeSettings: (next: JsonObject) => void;
  disabled?: boolean;
  providers?: Providers;
  savePick?: (scope: string, patch: AgentPickPatch) => void;
  onFavorite?: (provider: Provider, favoriteModels: string[]) => Promise<void>;
}) {
  const id = `setting-${field.key}`;
  // Named by the field's label alone; its help and what the pick does describe it.
  const named = { "aria-labelledby": `${id}-label`, "aria-describedby": `${id}-help` };
  let control;
  // A choice says what the picked option does, in the format's words, under the field's own help.
  let picked: string | undefined;
  // Options that come with pictures (a maker's styles) are picked by looking, not from a list.
  const pictures = field.kind === "choice" && field.options.some((o) => o.preview);
  switch (field.kind) {
    case "choice":
      picked = field.options.find((o) => o.value === value)?.description;
      control = pictures ? (
        <PictureChoice id={id} field={field} value={typeof value === "string" ? value : undefined} disabled={disabled} onChange={onChange} />
      ) : (
        <select id={id} {...named} disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)}>
          {typeof value !== "string" && <option value="">Default</option>}
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case "choices": {
      // Picked, never typed: each option with what it does. The fewest allowed stay picked; at the most, the rest wait.
      const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      const min = Math.max(field.minItems ?? 0, 0);
      const max = field.maxItems;
      control = (
        <span className="picks" role="group" aria-label={field.label}>
          {field.options.map((o) => {
            const on = list.includes(o.value);
            const locked = on ? list.length <= min : max !== undefined && list.length >= max;
            return (
              <label key={o.value} className="pick">
                <input
                  type="checkbox"
                  disabled={disabled || locked}
                  checked={on}
                  onChange={() => onChange(on ? list.filter((v) => v !== o.value) : field.options.map((x) => x.value).filter((v) => v === o.value || list.includes(v)))}
                />
                <span>
                  {o.label}
                  {o.description && <small>{o.description}</small>}
                </span>
              </label>
            );
          })}
        </span>
      );
      break;
    }
    case "number": {
      const special = specialValue(field, value as JsonObject[string]);
      picked = special?.description;
      control = <NumberControl id={id} named={named} field={field} value={value} disabled={disabled} onChange={onChange} />;
      break;
    }
    case "toggle":
      control = <input id={id} {...named} type="checkbox" disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case "text":
      control = (
        <input id={id} {...named} disabled={disabled} maxLength={field.maxLength} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || undefined)} />
      );
      break;
    case "textList": {
      const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      control = (
        <textarea
          id={id} {...named}
          rows={3}
          disabled={disabled}
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
    case "agent": {
      const turnKind = field.turnKind ?? "work";
      const rail = providers?.providers.filter(onRail) ?? [];
      const pickValue = typeof value === "string" && value !== "auto" && value !== "agent" ? value : undefined;
      const rawEffort = field.effortKey ? settings[field.effortKey] : undefined;
      const effortValue = typeof rawEffort === "string" && rawEffort !== "auto" ? rawEffort : undefined;
      const shown = providers?.connector.configured && providers.connector.reachable ? shownChoice(rail, pickValue, turnKind) : undefined;
      const effortNow = shown ? shownEffort(shown.provider, effortValue, turnKind) : undefined;
      const hasExplicitPick = Boolean(pickValue || effortValue);
      picked = workGuidance(shown?.provider, shown?.model, effortNow);

      const handlePick = (nextPick: string) => {
        const nextShown = shownChoice(rail, nextPick, turnKind);
        const switchedProvider = shown?.provider.id !== nextShown?.provider.id;
        const nextSettings = setField(format, settings, field.key, nextPick);
        if (switchedProvider && field.effortKey) delete nextSettings[field.effortKey];
        onChangeSettings(nextSettings);
        savePick?.(format.id, {
          agent: nextShown?.provider.id ?? null,
          model: nextShown?.model?.id ?? null,
          ...(switchedProvider ? { effort: null } : {}),
        });
      };

      const handleEffort = (nextEffort: string) => {
        if (!field.effortKey) return;
        let nextSettings = settings;
        if (shown && !pickValue) {
          nextSettings = setField(format, nextSettings, field.key, shown.pick);
        }
        nextSettings = setField(format, nextSettings, field.effortKey, nextEffort);
        onChangeSettings(nextSettings);
        savePick?.(format.id, {
          ...(shown ? { agent: shown.provider.id, model: shown.model?.id ?? null } : {}),
          effort: nextEffort,
        });
      };

      const handleReset = () => {
        let nextSettings = setField(format, settings, field.key, undefined);
        if (field.effortKey) nextSettings = setField(format, nextSettings, field.effortKey, undefined);
        onChangeSettings(nextSettings);
        savePick?.(format.id, { agent: null, model: null, effort: null });
      };

      if (!providers?.connector.configured) {
        control = <small className="d">Uses your connected agent's default.</small>;
      } else {
        control = (
          <span className="agentfld">
            <ModelPicker
              providers={providers}
              {...(pickValue ? { picked: pickValue } : {})}
              {...(effortValue ? { effort: effortValue } : {})}
              disabled={disabled}
              placement="down"
              turnKind={turnKind}
              onPick={handlePick}
              onEffort={handleEffort}
              onFavorite={(provider, ids) => void onFavorite?.(provider, ids)}
            />
            {hasExplicitPick && (
              <button type="button" className="quiet" disabled={disabled} onClick={handleReset}>
                Use default
              </button>
            )}
          </span>
        );
      }
      break;
    }
  }
  // A box holding more than one control (several picks, a number with its ticks, an agent picker) can't be one label.
  const Box = field.kind === "choices" || field.kind === "agent" || pictures || (field.kind === "number" && field.specialValues?.length) ? "div" : "label";
  return (
    <Box className={`fld${field.kind === "toggle" ? " toggle" : ""}${field.kind === "choices" || field.kind === "agent" || pictures ? " wide" : ""}`} {...(Box === "label" ? { htmlFor: id } : {})}>
      <span id={`${id}-label`}>{field.label}</span>
      {/* Several picks read their help first, then the options with what each does. */}
      {field.kind === "choices" && field.help && <small className="lead">{field.help}</small>}
      {control}
      <span id={`${id}-help`}>
        {/* A number holding a special value is not a number: what that value means stands in for the help. */}
        {field.help && field.kind !== "choices" && !(field.kind === "number" && picked) && <small>{field.help}</small>}
        {picked && <small className="picked">{picked}</small>}
      </span>
    </Box>
  );
}

/**
 * One option of several, each a small picture card with its name: a radio
 * group, so arrow keys move the pick and a screen reader reads each name
 * (the picture adds nothing a name does not say). An option without a
 * picture, or whose picture does not load, shows its name on a plain card.
 */
function PictureChoice({
  id,
  field,
  value,
  disabled,
  onChange,
}: {
  id: string;
  field: SettingField & { kind: "choice" };
  value: string | undefined;
  disabled?: boolean;
  onChange: (v: string | undefined) => void;
}) {
  return (
    <span className="looks" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`}>
      {field.options.map((o) => (
        <label key={o.value} className={`look${o.value === value ? " on" : ""}`} title={o.description}>
          <input type="radio" name={id} value={o.value} disabled={disabled} checked={o.value === value} onChange={() => onChange(o.value)} />
          <Picture src={previewUrl(o.preview)} />
          <span className="nm">{o.label}</span>
        </label>
      ))}
    </span>
  );
}

function Picture({ src }: { src: string | undefined }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <span className="ph none" aria-hidden="true" />;
  return (
    <span className="ph" aria-hidden="true">
      <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
    </span>
  );
}

/**
 * A number, with the values that mean something else ("Fit to the brief") as
 * ticks beside it. While one is ticked there is no number to type;
 * unticking brings the box, focused, and keeps the special value until a
 * number is typed.
 */
function NumberControl({
  id,
  named,
  field,
  value,
  disabled,
  onChange,
}: {
  id: string;
  named: Record<string, string>;
  field: SettingField & { kind: "number" };
  value: unknown;
  disabled?: boolean;
  onChange: (v: number | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [typing, setTyping] = useState(false);
  const special = specialValue(field, value as JsonObject[string]);
  const held = special !== undefined && !typing;
  return (
    <span className="numfield">
      {!held && (
        <>
          <input
            ref={input}
            id={id}
            {...named}
            type="number"
            disabled={disabled}
            min={field.min}
            max={field.max}
            step={field.step}
            value={typeof value === "number" && !special ? value : ""}
            onChange={(e) => {
              setTyping(false);
              onChange(e.target.value === "" ? undefined : Number(e.target.value));
            }}
          />
          {field.unit && <span className="d">{field.unit}</span>}
        </>
      )}
      {(field.specialValues ?? []).map((v) => {
        const on = special?.value === v.value && !typing;
        return (
          <label key={v.value} className="pick special">
            <input
              type="checkbox"
              disabled={disabled}
              checked={on}
              onChange={() => {
                if (on) {
                  setTyping(true);
                  // The box is enabled on the next paint; then it takes the typing.
                  requestAnimationFrame(() => input.current?.focus());
                } else {
                  setTyping(false);
                  onChange(v.value);
                }
              }}
            />
            <span>{v.label}</span>
          </label>
        );
      })}
    </span>
  );
}
