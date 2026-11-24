import SwiftUI

/// An output card that opens the player when its type has one. Cards for
/// types without a player stay visible but do nothing on tap.
struct OutputCardButton: View {
    @EnvironmentObject private var appState: AppState
    let output: Output
    var style: OutputCardView.Style = .gallery
    /// The list this card was opened from, so the player pages through it.
    var queue: PlayerQueue? = nil

    var body: some View {
        Button {
            guard PlayerRegistry.standard.canPlay(output.type) else { return }
            OpenSourcebookHaptics.lightImpact()
            appState.present(output, in: queue)
        } label: {
            OutputCardView(output, style: style)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
