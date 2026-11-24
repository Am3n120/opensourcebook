import { useEffect, useState, type ReactNode } from "react";

type Seen = { state: "asking" } | { state: "in" } | { state: "out"; reason: "not_opened" | "not_set_up"; message: string };

/**
 * The app, once the proxy has let this browser in (web/worker/proxy.ts). A browser Open Sourcebook did not let in, such as one
 * where the address was typed by hand, sees one plain page that says how to open Open Sourcebook instead of screens that cannot
 * load: first what to do without a terminal, then the command. When it was not started by the launcher at all, the page
 * shows what the proxy says instead. Anything else (no answer at all) shows the app, whose screens say the server is not reachable.
 */
export function OpenGate({ children, fetchImpl }: { children: ReactNode; fetchImpl?: typeof fetch }) {
  const [seen, setSeen] = useState<Seen>({ state: "asking" });
  useEffect(() => {
    let live = true;
    const f = fetchImpl ?? globalThis.fetch;
    f("/api/session", { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (r.ok) return { state: "in" } as const;
        const body = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
        if (body.error === "not_opened" || body.error === "not_set_up") return { state: "out", reason: body.error, message: body.message ?? "" } as const;
        return { state: "in" } as const;
      })
      .catch(() => ({ state: "in" }) as const)
      .then((next) => live && setSeen(next));
    return () => {
      live = false;
    };
  }, [fetchImpl]);
  if (seen.state === "asking") return null;
  if (seen.state === "in") return <>{children}</>;
  return (
    <main className="open-gate" style={{ maxWidth: "34rem", margin: "15vh auto", padding: "0 20px" }}>
      <h1>Open this page from Open Sourcebook</h1>
      {seen.reason === "not_opened" ? (
        <>
          <p>Start Open Sourcebook again, the same way you started it before. It opens the right page for you.</p>
          <p>
            If you use a terminal, the command is <code>opensourcebook open</code>, or <code>npm run open</code> in its folder.
          </p>
        </>
      ) : (
        <p>{seen.message}</p>
      )}
      <p>
        An address typed by hand, or kept from an earlier day, shows this page. Open Sourcebook works only in the browser it opened
        itself, so no other program and no other person on this computer can reach your projects.
      </p>
    </main>
  );
}
