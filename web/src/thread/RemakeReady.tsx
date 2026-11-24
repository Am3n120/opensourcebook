import type { Output } from "../api/types";
import { OutlineButton } from "../design/Buttons";
import { useRemake } from "./remake";
import "./remake.css";

/**
 * Over a made thing being watched, once a scene of it was made again and
 * the new one is written: a quiet line saying so, with Play. Nothing moves
 * on its own; the person keeps watching until they press it. Drawn only for
 * a thing one of whose scenes can be made again.
 */
export function RemakeReady({ output, onPlay }: { output: Output; onPlay: (outputId: string, itemId: string) => void }) {
  const can = output.remakesScene === true && !!output.planId && !!output.itemId;
  const { newer } = useRemake(can ? output.planId : undefined, output.itemId, output.id);
  if (!can || !newer) return null;
  return (
    <div className="rready" role="status">
      <span>The new one is ready</span>
      <OutlineButton icon="play" onClick={() => onPlay(newer, output.itemId!)}>
        Play
      </OutlineButton>
    </div>
  );
}
