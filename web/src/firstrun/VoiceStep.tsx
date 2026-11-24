import { useState } from "react";
import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";
import { ErrorNotice } from "../app/Status";
import { OutlineButton, PrimaryButton } from "../design/Buttons";
import { VoiceSetup } from "../voice/VoiceSetup";

/**
 * Step 2: the shared voice form. A person can go on without a voice; the
 * screen says what that means (a video has no sound).
 */
export function VoiceStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const client = useApi();
  const setup = useLoad(() => client.setup(), [client]);
  const [chosen, setChosen] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<unknown>();
  const set = chosen || setup.data?.voice.set === true;
  // The engine keeps that it was skipped, so setup does not come back to this step.
  async function skip() {
    setSkipping(true);
    setError(undefined);
    try {
      await client.skipVoice();
      onNext();
    } catch (e) {
      setError(e);
      setSkipping(false);
    }
  }
  return (
    <>
      <section className="fr-card" aria-labelledby="fr-h">
        <div className="fr-head">
          <h1 id="fr-h">Give your videos and audio a voice</h1>
          <p>Without one, videos have no sound (the captions carry the words) and audio can&apos;t be made. You can do this later.</p>
        </div>
        <div className="fr-body">
          <VoiceSetup compact onDone={() => setChosen(true)} />
        </div>
      </section>
      <div className="fr-foot">
        <OutlineButton onClick={onBack}>Back</OutlineButton>
        <span className="fr-sp" />
        {!set && (
          <button type="button" className="fr-skip" disabled={skipping} onClick={() => void skip()}>
            Skip for now
          </button>
        )}
        <PrimaryButton className="fr-next" disabled={!set} onClick={onNext}>
          Next
        </PrimaryButton>
      </div>
      <ErrorNotice error={error} />
    </>
  );
}
