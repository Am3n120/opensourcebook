import SwiftUI
import Combine
import AVFoundation

/// Streaming audio player block: play/pause, elapsed/total time, slider scrubber.
/// Shows a buffering spinner while the stream stalls and degrades to a graceful
/// error state (with retry) if the stream can't load.
struct AudioBlockView: View {
    let url: String
    let title: String
    let subtitle: String?

    @State private var player: AVPlayer?
    @State private var isPlaying = false
    @State private var isBuffering = false
    @State private var elapsed: Double = 0
    @State private var duration: Double = 0
    @State private var failed = false

    private let ticker = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                Image(systemName: "waveform")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(
                        LinearGradient(colors: [Color(hex: 0x8B5CF6), OpenSourcebookTheme.Colors.primary],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .lineLimit(2)
                    if let subtitle {
                        Text(subtitle)
                            .font(OpenSourcebookTheme.Fonts.label)
                            .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: OpenSourcebookTheme.Spacing.xs)
            }

            if failed {
                HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(OpenSourcebookTheme.Colors.accent)
                    Text("Audio couldn't be loaded. Check your connection and try again.")
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)

                    Spacer(minLength: OpenSourcebookTheme.Spacing.xs)

                    Button {
                        retry()
                    } label: {
                        Text("Try again")
                            .font(OpenSourcebookTheme.Fonts.label)
                            .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                            .padding(.horizontal, OpenSourcebookTheme.Spacing.sm)
                            .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
                            .background(OpenSourcebookTheme.Colors.primarySoft)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Try again")
                }
            } else {
                HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                    Button {
                        togglePlayback()
                    } label: {
                        ZStack {
                            Circle()
                                .fill(OpenSourcebookTheme.Colors.primary)
                                .frame(width: 44, height: 44)
                            if isBuffering {
                                ProgressView()
                                    .tint(.white)
                            } else {
                                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                                    .font(.system(size: 15, weight: .bold))
                                    .foregroundStyle(.white)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(isPlaying ? "Pause" : "Play")

                    VStack(spacing: OpenSourcebookTheme.Spacing.xxs) {
                        Slider(value: $elapsed, in: 0...max(duration, 1)) { editing in
                            if !editing {
                                player?.seek(to: CMTime(seconds: elapsed, preferredTimescale: 600))
                            }
                        }
                        .tint(OpenSourcebookTheme.Colors.primary)

                        HStack {
                            Text(format(elapsed))
                            Spacer()
                            Text(duration > 0 ? format(duration) : "--:--")
                        }
                        .font(.system(size: 11, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    }
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
        .onAppear(perform: preparePlayer)
        .onDisappear {
            player?.pause()
            isPlaying = false
            isBuffering = false
            deactivateAudioSession()
        }
        .onReceive(ticker) { _ in refreshState() }
        .onReceive(NotificationCenter.default.publisher(for: .AVPlayerItemFailedToPlayToEndTime)) { _ in
            failed = true
            isPlaying = false
            isBuffering = false
        }
    }

    // MARK: Player plumbing

    private func preparePlayer() {
        guard player == nil else { return }
        guard let streamURL = URL(string: url) else {
            failed = true
            return
        }
        let newPlayer = AVPlayer(url: streamURL)
        newPlayer.automaticallyWaitsToMinimizeStalling = true
        player = newPlayer
    }

    private func togglePlayback() {
        guard let player else { return }
        if isPlaying {
            player.pause()
            isPlaying = false
            isBuffering = false
            deactivateAudioSession()
        } else {
            // Without a .playback session the silent switch / route can mute us on device.
            activateAudioSession()
            player.play()
            isPlaying = true
            isBuffering = player.currentItem?.status != .readyToPlay
        }
        OpenSourcebookHaptics.lightImpact()
    }

    private func retry() {
        guard let streamURL = URL(string: url) else { return }
        player?.pause()
        failed = false
        isPlaying = false
        isBuffering = false
        elapsed = 0
        duration = 0
        let newPlayer = AVPlayer(url: streamURL)
        newPlayer.automaticallyWaitsToMinimizeStalling = true
        player = newPlayer
        OpenSourcebookHaptics.lightImpact()
    }

    private func refreshState() {
        guard let player, let item = player.currentItem else { return }
        if item.status == .failed {
            failed = true
            isPlaying = false
            isBuffering = false
            return
        }
        let seconds = item.duration.seconds
        if seconds.isFinite, !seconds.isNaN, seconds > 0 {
            duration = seconds
        }
        let current = item.currentTime().seconds
        if current.isFinite, !current.isNaN {
            elapsed = current
        }
        isBuffering = isPlaying
            && (item.status != .readyToPlay
                || player.timeControlStatus == .waitingToPlayAtSpecifiedRate)
        if duration > 0, elapsed >= duration { isPlaying = false }
    }

    private func activateAudioSession() {
        #if canImport(UIKit)
        // Session activation can block; keep it off the main thread.
        DispatchQueue.global(qos: .userInitiated).async {
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playback, mode: .default)
            try? session.setActive(true)
        }
        #endif
    }

    private func deactivateAudioSession() {
        #if canImport(UIKit)
        DispatchQueue.global(qos: .userInitiated).async {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        #endif
    }

    private func format(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
