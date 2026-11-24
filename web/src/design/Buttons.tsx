import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";

/** The outlined small pill (Play, Open, Stop). The class is exported so a link can wear it too. */
export const OUTLINE_BUTTON = "obtn";
/** The filled primary pill ("Make the video"). `wide` fills its row, as at the foot of a phone sheet. */
export const PRIMARY_BUTTON = "pbtn";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { children: ReactNode; icon?: string };

export function OutlineButton({ children, icon, className, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={`${OUTLINE_BUTTON}${className ? ` ${className}` : ""}`} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function PrimaryButton({ children, icon, wide, className, type = "button", ...rest }: ButtonProps & { wide?: boolean }) {
  return (
    <button type={type} className={`${PRIMARY_BUTTON}${wide ? " wide" : ""}${className ? ` ${className}` : ""}`} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
