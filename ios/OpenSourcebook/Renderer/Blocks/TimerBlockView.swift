import SwiftUI
import Combine

/// Interactive countdown timer: start/pause/reset, mm:ss, subtle done state.
struct TimerBlockView: View {
    let label: String
    let seconds: Int

    @State private var remaining: Int
    @State private var isRunning = false

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    init(label: String, seconds: Int) {
        self.label = label
        self.seconds = max(1, seconds)
        _remaining = State(initialValue: max(1, seconds))
    }

    private var isDone: Bool { remaining == 0 }

    var body: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.md) {
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
                Text(label)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(isDone ? OpenSourcebookTheme.Colors.success : OpenSourcebookTheme.Colors.muted)
                Text(timeText)
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(isDone ? OpenSourcebookTheme.Colors.success : OpenSourcebookTheme.Colors.text)
                if isDone {
                    Text("Done")
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.success)
                }
            }

            Spacer()

            HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                Button {
                    isRunning.toggle()
                    OpenSourcebookHaptics.lightImpact()
                } label: {
                    Image(systemName: isRunning ? "pause.fill" : "play.fill")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 44, height: 44)
                        .background(isDone ? OpenSourcebookTheme.Colors.muted : OpenSourcebookTheme.Colors.primary)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(isDone)

                Button {
                    isRunning = false
                    remaining = seconds
                    OpenSourcebookHaptics.lightImpact()
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        .frame(width: 44, height: 44)
                        .background(OpenSourcebookTheme.Colors.fill)
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
        .onReceive(ticker) { _ in
            guard isRunning, remaining > 0 else { return }
            remaining -= 1
            if remaining == 0 { isRunning = false }
        }
    }

    private var timeText: String {
        String(format: "%d:%02d", remaining / 60, remaining % 60)
    }
}
