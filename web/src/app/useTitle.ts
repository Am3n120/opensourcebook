import { useEffect } from "react";

/** The window's title: what is on screen, then Open Sourcebook. Undefined (still loading) keeps plain "Open Sourcebook". */
export function useTitle(what: string | undefined): void {
  useEffect(() => {
    document.title = what ? `${what} · Open Sourcebook` : "Open Sourcebook";
    return () => {
      document.title = "Open Sourcebook";
    };
  }, [what]);
}
