import { Icon } from "../design/Icon";
import { OutlineButton, PrimaryButton } from "../design/Buttons";

/**
 * What a plan or a feed ends on, after its last made thing: how many it
 * held, how many are done and left, whether more is coming, a way back,
 * and the first one left when there is one. `whole` names what ended
 * ("plan", "project", "feed"), in plain words.
 */
export function EndCard({
  whole,
  total,
  done,
  coming,
  back,
  left,
}: {
  whole: string;
  /** Made things in it. */
  total: number;
  /** How many of them are ticked done. */
  done: number;
  /** Whether more is still being made or waits to be made in it; absent when that is not known (a feed). */
  coming?: boolean | undefined;
  back: { label: string; onClick: () => void };
  /** The first made thing not done yet: offered as the way on. */
  left?: { onClick: () => void } | undefined;
}) {
  const open = total - done;
  const heading = total === 1 ? `That's the one in this ${whole}` : `That's all ${total} in this ${whole}`;
  const counts = open === 0 ? (total === 1 ? "It's done." : "All of them done.") : `${done} done, ${open} left for later.`;
  const more = coming === undefined ? "" : coming ? ` More is coming in this ${whole}.` : ` Nothing more is coming in this ${whole}.`;
  return (
    <section className="endcard" aria-label="The end">
      <span className="ec-tick" aria-hidden="true">
        <Icon name="check" />
      </span>
      <h2>{heading}</h2>
      <p>
        {counts}
        {more}
      </p>
      <div className="ec-acts">
        <PrimaryButton wide onClick={back.onClick}>
          {back.label}
        </PrimaryButton>
        {left && open > 0 && (
          <OutlineButton className="wide" onClick={left.onClick}>
            {open === 1 ? "Go to the one left" : "Go to the first one left"}
          </OutlineButton>
        )}
      </div>
    </section>
  );
}
