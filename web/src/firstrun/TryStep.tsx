import { useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../app/context";
import { ErrorNotice } from "../app/Status";
import { useLoad } from "../app/useLoad";
import { OutlineButton } from "../design/Buttons";
import { summaryLine } from "./rules";
import { EXAMPLES, exampleCounts, openExample } from "../screens/examples";

/**
 * Step 3: the way into the app, a project of the person's own or the example.
 * Choosing one marks setup done, so the steps are not shown again.
 */
export function TryStep({ onBack }: { onBack: () => void }) {
  const client = useApi();
  const navigate = useNavigate();
  const setup = useLoad(() => client.setup(), [client]);
  const example = EXAMPLES[0];
  const bundle = useLoad(async () => (example ? example.load() : undefined), [example]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function go(open: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await client.setSetup(true);
      if (open && example) {
        const project = await openExample(client, example);
        navigate(`/projects/${project.id}`, { replace: true });
      } else {
        navigate("/?new=1", { replace: true });
      }
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  const counts = bundle.data ? exampleCounts(bundle.data) : undefined;

  return (
    <>
      <section className="fr-card" aria-labelledby="fr-h">
        <div className="fr-head">
          <h1 id="fr-h">You&apos;re set up</h1>
          <p>
            {setup.data ? `${summaryLine(setup.data.providers.connected, setup.data.voice.set)}. ` : ""}
            Start your own project, or look around one that is already made.
          </p>
        </div>
        <div className="fr-cards">
          <button type="button" className="fr-go new" disabled={busy} onClick={() => void go(false)}>
            <b>New project</b>
            <span>Drop in a source and ask about it, or make something from it.</span>
          </button>
          {example && (
            <button type="button" className="fr-go" disabled={busy} onClick={() => void go(true)}>
              <b>Open the example</b>
              <span>
                {counts ? exampleLine(counts) : "A finished project to look around."}
              </span>
            </button>
          )}
        </div>
        <ErrorNotice error={error} />
      </section>
      <div className="fr-foot">
        <OutlineButton onClick={onBack} disabled={busy}>
          Back
        </OutlineButton>
      </div>
    </>
  );
}

/** What the example holds, said in a line or two: its sources, and what is already made or answered in it. */
function exampleLine(counts: ReturnType<typeof exampleCounts>): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const sources = n(counts.sources, "source", "sources");
  const inside = [
    ...(counts.made.length > 0 ? [`${n(counts.made.length, "thing", "things")} already made`] : []),
    ...(counts.answers > 0 ? [`${n(counts.answers, "answer", "answers")} in a chat`] : []),
  ];
  return `${sources}${inside.length > 0 ? `, with ${inside.join(" and ")}` : ""}. Open it and ask more.`;
}
