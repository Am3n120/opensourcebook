import SwiftUI

/// Maps a format to the view that plays it inside the player shell
/// (DECISIONS.md #5: one shell, one player per format). A format with no
/// entry has no player in this build; the shell shows that honestly instead
/// of guessing. Adding a player later is one `register` call and no change to
/// the shell. Old ids resolve through the format catalog's aliases.
@MainActor
struct PlayerRegistry {
    private var builders: [FormatID: (Output) -> AnyView] = [:]
    private var feedFormats: Set<FormatID> = []

    init() {}

    /// `inFeed`: outputs in this format stream in the Feed.
    mutating func register<Player: View>(
        _ format: FormatID,
        inFeed: Bool = false,
        @ViewBuilder player: @escaping (Output) -> Player
    ) {
        builders[format] = { AnyView(player($0)) }
        if inFeed { feedFormats.insert(format) }
    }

    func canPlay(_ format: FormatID, catalog: FormatCatalog = FormatRegistry.shared.catalog) -> Bool {
        builders[catalog.canonicalID(for: format)] != nil
    }

    func playsInFeed(_ format: FormatID, catalog: FormatCatalog = FormatRegistry.shared.catalog) -> Bool {
        let id = catalog.canonicalID(for: format)
        return feedFormats.contains(id) && builders[id] != nil
    }

    /// The player for `output`, or nil when its format has none yet.
    func player(for output: Output, catalog: FormatCatalog = FormatRegistry.shared.catalog) -> AnyView? {
        builders[catalog.canonicalID(for: output.type)]?(output)
    }

    /// What this build can play. Old bits and read outputs are bytes and
    /// resolve here through the catalog's aliases.
    static let standard: PlayerRegistry = {
        var registry = PlayerRegistry()
        registry.register("byte", inFeed: true) { BytePlayerView(output: $0) }
        registry.register("quiz", inFeed: true) { QuizPlayerView(output: $0) }
        // Not in the Feed until a video engine makes videos it can play.
        registry.register("video") { VideoPlayerView(output: $0) }
        return registry
    }()
}
