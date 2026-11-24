import type { ReactNode } from "react";
import type { FormatDescriptor } from "../api/types";
import { AudioPlayer } from "./AudioPlayer";
import { findFormat } from "../design/formatLook";
import { FlashcardsPlayer } from "./FlashcardsPlayer";
import { GuidePlayer } from "./GuidePlayer";
import type { PlayerProps } from "./players";
import { QuizPlayer } from "./QuizPlayer";
import { VideoPlayer } from "./VideoPlayer";

/**
 * Which player plays a format. A player registers the format ids it plays,
 * as the phone's PlayerRegistry does; old ids resolve through the engine's
 * descriptors (aliases). A format with no web player yet gets none.
 */
const PLAYERS: Record<string, (props: PlayerProps) => ReactNode> = {
  audio: (props) => <AudioPlayer {...props} />,
  flashcards: (props) => <FlashcardsPlayer {...props} />,
  guide: (props) => <GuidePlayer {...props} />,
  quiz: (props) => <QuizPlayer {...props} />,
  video: (props) => <VideoPlayer {...props} />,
};

/** The player for a format, drawn; undefined when the web has none for it. */
export function renderPlayer(formats: readonly FormatDescriptor[], type: string, props: PlayerProps): ReactNode | undefined {
  return PLAYERS[findFormat(formats, type)?.id ?? type]?.(props);
}
