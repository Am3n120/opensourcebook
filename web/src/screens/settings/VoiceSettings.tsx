import { useId } from "react";
import { useSearchParams } from "react-router";
import { VoiceSetup } from "../../voice/VoiceSetup";
import { SectionHead } from "./SectionHead";

/** Settings › Voice: the voice that speaks videos and audio, set up with the same form as first-time setup. */
export function VoiceSettings() {
  const heading = useId();
  // `?voice=<id>` opens on that service, as the voice picker's "Set up" asks.
  const [params] = useSearchParams();
  const start = params.get("voice") ?? undefined;
  return (
    <section className="sx-sec" aria-labelledby={heading}>
      <SectionHead id={heading} title="Voice">
        The voice that speaks your videos and audio. Without one, videos come out with no sound (captions carry the words) and audio can't be made.
      </SectionHead>
      <VoiceSetup key={start} {...(start ? { start } : {})} />
    </section>
  );
}
