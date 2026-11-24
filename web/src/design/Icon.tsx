import { ICONS } from "./icons";

/** A line icon from the shared set; an unknown name draws the "doc" icon. */
export function Icon({ name, className = "ico", title }: { name: string; className?: string; title?: string }) {
  const body = ICONS[name] ?? ICONS.doc ?? "";
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}
