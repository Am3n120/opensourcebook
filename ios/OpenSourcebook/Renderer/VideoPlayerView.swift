import AVKit
import SwiftUI

/// Plays a video (DECISIONS.md #33): it fills the screen and has nothing
/// sideways (#36); scrolling still moves to the next item. A video made by
/// the engine plays its file (engine/docs/video.md, "Players") and nothing
/// else is drawn over it (#49): a storyboard says so inside its own frames. An older video output plays its one moving-picture block
/// (a YouTube video or a clip of the source); otherwise it says honestly that
/// it can't play it.
struct VideoPlayerView: View {
    let output: Output

    var body: some View {
        ZStack {
            Color.black
            if let file = output.video, let url = AssetURLResolver.resolve(file.url) {
                VideoFileView(url: url, storyboard: file.storyboard)
            } else if let media = Self.media(of: output) {
                BlockView(block: media)
                    .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
            } else {
                VStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                    Image(systemName: "play.rectangle")
                        .font(.system(size: 34, weight: .semibold))
                    Text(output.title)
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .multilineTextAlignment(.center)
                    Text("This build can't play this video yet.")
                        .font(OpenSourcebookTheme.Fonts.caption)
                }
                .foregroundStyle(.white.opacity(0.85))
                .padding(OpenSourcebookTheme.Spacing.lg)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("video-\(output.id.uuidString)")
    }

    /// The block a video output plays: its first video or clip.
    nonisolated static func media(of output: Output) -> Block? {
        output.allBlocks.first { block in
            switch block {
            case .video, .clip: true
            default: false
            }
        }
    }
}

/// The video's file in the system player, paused when it leaves the screen.
private struct VideoFileView: View {
    let url: URL
    let storyboard: Bool

    @State private var player: AVPlayer?

    var body: some View {
        VideoPlayer(player: player)
            .accessibilityLabel(storyboard ? "Video, storyboard" : "Video")
            .onAppear {
                if player == nil { player = AVPlayer(url: url) }
            }
            .onDisappear { player?.pause() }
    }
}
