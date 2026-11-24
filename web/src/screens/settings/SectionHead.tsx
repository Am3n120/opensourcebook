import type { ReactNode } from "react";

/** A section's title, its one or two plain lines, and an action at the right when it has one. */
export function SectionHead({ id, title, children, action }: { id: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <header className="sx-head">
      <div>
        <h2 id={id}>{title}</h2>
        {children && <p>{children}</p>}
      </div>
      {action}
    </header>
  );
}
