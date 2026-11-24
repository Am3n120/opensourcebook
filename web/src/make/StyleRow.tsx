import { useState } from "react";
import { useFormats } from "../app/context";
import { StylePicker, StyleThumb } from "./StylePicker";
import { styleList, styleOf } from "./styles";
import "./make.css";

export interface StyleRowProps {
  value: string | null;
  onChange(id: string): void;
  /** The shape whose styles to show; the first with picture styles when left out. */
  format?: string;
}

/** The make sheet's style row: the style's picture, its name and "Change", which opens the style picker. Nothing when no style is offered. */
export function StyleRow({ value, onChange, format }: StyleRowProps) {
  const list = styleList(useFormats(), format);
  const [open, setOpen] = useState(false);
  if (!list) return null;
  const style = styleOf(list, value);
  return (
    <>
      <button type="button" className="st-row" aria-label={`${list.field.label}: ${style?.label ?? "none picked"}. Change`} onClick={() => setOpen(true)}>
        <StyleThumb option={style} className="st-row-thumb" />
        <b>{style?.label ?? "Pick a style"}</b>
        <span className="st-change">Change</span>
      </button>
      {open && <StylePicker value={value} format={format} onChange={onChange} onClose={() => setOpen(false)} />}
    </>
  );
}
