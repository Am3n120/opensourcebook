import { useEffect, useRef, useState } from "react";
import { useApi } from "../app/context";

/** What a voice's play button says when its sample cannot be played. */
export const SAMPLE_FAILED = "This voice's sample can't be played right now.";

/**
 * Plays one voice's sample at a time: which voice is playing, and which one
 * could not be played (the sample did not load or the browser refused it).
 * Pressing the playing voice again stops it.
 */
export function useSample(service: string) {
  const client = useApi();
  const [playing, setPlaying] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);

  function play(voiceId: string) {
    audio.current?.pause();
    audio.current = null;
    setFailed(undefined);
    if (playing === voiceId) {
      setPlaying(undefined);
      return;
    }
    const a = new Audio(client.voiceSampleUrl(service, voiceId));
    audio.current = a;
    const mine = () => audio.current === a;
    a.onended = () => mine() && setPlaying(undefined);
    const fail = () => {
      if (!mine()) return;
      setPlaying(undefined);
      setFailed(voiceId);
    };
    a.onerror = fail;
    setPlaying(voiceId);
    void a.play()?.catch(fail);
  }

  return { playing, failed, play };
}
