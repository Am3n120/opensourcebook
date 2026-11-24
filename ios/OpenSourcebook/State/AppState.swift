import SwiftUI

/// Root tabs (DECISIONS.md #16). Capture is a sheet from the center button,
/// not a tab.
enum AppTab: Hashable {
    case home, feed, library, profile
}

/// UI-only state shared across screens: which tab is showing, whether the
/// capture sheet is up, and what the player is showing. Nothing here is
/// persisted; durable state lives in `OutputStore`.
@MainActor
final class AppState: ObservableObject {
    @Published var selectedTab: AppTab = .home
    @Published var isCapturePresented = false
    /// Output presented in the full-screen player, if any.
    @Published var presentedOutputID: UUID?
    /// The list the player plays through; nil means the default for the output.
    @Published var presentedQueue: PlayerQueue?
    /// Project to preselect when the capture sheet opens.
    @Published var captureDestination: CaptureDestination = .auto

    func openCapture(into destination: CaptureDestination = .auto) {
        captureDestination = destination
        isCapturePresented = true
    }

    func present(_ output: Output, in queue: PlayerQueue? = nil) {
        presentedQueue = queue
        presentedOutputID = output.id
    }

    func dismissPlayer() {
        presentedOutputID = nil
        presentedQueue = nil
    }

    /// Binding target for the full-screen player cover.
    var isPlayerPresented: Bool {
        get { presentedOutputID != nil }
        set { if !newValue { dismissPlayer() } }
    }
}
