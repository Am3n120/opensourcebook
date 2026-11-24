import OSLog
import SwiftUI

private let playerLog = Logger(subsystem: "app.opensourcebook", category: "Player")

/// One shell for every shape (DECISIONS.md #5), with one gesture rule
/// (#36): scrolling down goes to the next item and up to the previous, one
/// item per screen; swiping sideways moves inside the item (a byte's bits),
/// which is the item's own player's business. The shell never sorts; it asks
/// the injected `OutputOrdering` what comes next (#6). Used full-screen for a
/// plan, a project or Library (with `onClose`) and inline in the Feed
/// (without); the same rule everywhere.
struct PlayerShellView: View {
    @EnvironmentObject private var store: OutputStore
    @EnvironmentObject private var doneTicks: DoneTickStore

    let outputs: [Output]
    let ordering: any OutputOrdering
    var startID: UUID?
    /// Shows a close button when set.
    var onClose: (() -> Void)?
    /// False where items are shown without the user choosing one (the Feed),
    /// so merely passing by neither counts as opening nor ticks anything.
    var marksOpened = true

    @State private var page: PlayerPage?

    /// The top bar's title area: a format badge over one line of title.
    private static let titleHeight: CGFloat = 52

    private var context: OrderingContext { OrderingContext(meta: store.meta) }

    var body: some View {
        let order = ordering.ordered(outputs, context: context)
        let ids = order.map(\.id)
        let current = page?.itemID.flatMap { id in order.first { $0.id == id } }
            ?? (page == .end ? nil : order.first)
        VStack(spacing: 0) {
            if order.isEmpty {
                EmptyStateView(icon: "tray", title: "Nothing to play",
                               message: "There are no items here yet.")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                topBar(current)
                pager(order)
                    .onChange(of: page) { old, new in moved(from: old, to: new, order: order) }
                bottomBar(ids)
            }
        }
        .background(OpenSourcebookTheme.Colors.background.ignoresSafeArea())
        .clipped()
        .onAppear {
            if page == nil, let first = startID ?? order.first?.id { page = .item(first) }
        }
        .task(id: current?.id) {
            if marksOpened, let id = current?.id { store.markOpened(id) }
        }
    }

    private func pager(_ order: [Output]) -> some View {
        ScrollView(.vertical) {
            LazyVStack(spacing: 0) {
                ForEach(order) { output in
                    PlayerPageView(output: output)
                        .containerRelativeFrame([.horizontal, .vertical])
                        .id(PlayerPage.item(output.id))
                }
                EmptyStateView(icon: "checkmark.circle", title: "That's everything",
                               message: "Scroll up to go back.")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .containerRelativeFrame([.horizontal, .vertical])
                    .id(PlayerPage.end)
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollIndicators(.hidden)
        .scrollPosition(id: $page)
        .accessibilityIdentifier("player-pager")
    }

    // MARK: - Chrome

    @ViewBuilder
    private func topBar(_ output: Output?) -> some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            if let onClose {
                Button {
                    onClose()
                } label: {
                    barIcon("xmark")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
                if let output {
                    TypeBadge(output.type)
                    Text(output.title)
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .lineLimit(1)
                } else {
                    Text("The end")
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                }
            }
            // One height on every page: if the bar grew or shrank with the
            // page, the pager under it would resize mid-scroll, land between
            // pages and flip back and forth without settling.
            .frame(height: Self.titleHeight, alignment: .leading)
            Spacer(minLength: OpenSourcebookTheme.Spacing.xs)
            if let output {
                let isFavorite = store.isFavorite(output.id)
                Button {
                    OpenSourcebookHaptics.lightImpact()
                    store.setFavorite(!isFavorite, for: output.id)
                } label: {
                    barIcon(isFavorite ? "star.fill" : "star",
                            tint: isFavorite ? OpenSourcebookTheme.Colors.accent : OpenSourcebookTheme.Colors.text)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isFavorite ? "Remove from Favorites" : "Add to Favorites")
            }
        }
        .padding(.horizontal, OpenSourcebookTheme.Spacing.lg)
        .padding(.vertical, OpenSourcebookTheme.Spacing.sm)
        .background(OpenSourcebookTheme.Colors.background)
    }

    /// Where you are in the list, and up and down for those who'd rather tap.
    private func bottomBar(_ ids: [UUID]) -> some View {
        let previous = PlayerPaging.neighbour(of: page, in: ids, down: false)
        let next = PlayerPaging.neighbour(of: page, in: ids, down: true)
        let index = page?.itemID.flatMap { ids.firstIndex(of: $0) } ?? (page == .end ? ids.count - 1 : 0)
        return HStack {
            Button { move(to: previous) } label: { barIcon("chevron.up") }
                .buttonStyle(.plain)
                .disabled(previous == nil)
                .opacity(previous == nil ? 0.35 : 1)
                .accessibilityLabel("Previous")
            Spacer()
            Text("\(index + 1) of \(ids.count)")
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                .accessibilityIdentifier("player-position")
            Spacer()
            Button { move(to: next) } label: { barIcon("chevron.down") }
                .buttonStyle(.plain)
                .disabled(next == nil)
                .opacity(next == nil ? 0.35 : 1)
                .accessibilityLabel("Next")
        }
        .padding(.horizontal, OpenSourcebookTheme.Spacing.lg)
        .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
        .background(OpenSourcebookTheme.Colors.background)
    }

    private func barIcon(_ name: String, tint: Color = OpenSourcebookTheme.Colors.text) -> some View {
        Image(systemName: name)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 40, height: 40)
            .background(OpenSourcebookTheme.Colors.surface)
            .clipShape(Circle())
            .overlay(Circle().stroke(OpenSourcebookTheme.Colors.border, lineWidth: 1))
    }

    // MARK: - Moving between items

    private func move(to target: PlayerPage?) {
        guard let target else { return }
        withAnimation(OpenSourcebookTheme.Motion.standard) { page = target }
    }

    /// Moving on is finishing: scrolling down past an item (or tapping next)
    /// ticks it done if it belongs to a plan. Where items only pass by (the
    /// Feed) nothing is ticked.
    private func moved(from old: PlayerPage?, to new: PlayerPage?, order: [Output]) {
        guard old != new, new != nil else { return }
        OpenSourcebookHaptics.lightImpact()
        guard marksOpened,
              let finished = PlayerPaging.finished(movingFrom: old, to: new, in: order.map(\.id)),
              let output = order.first(where: { $0.id == finished }) else { return }
        playerLog.debug("Finished \(output.id.uuidString, privacy: .public) by moving on")
        doneTicks.markDone(output)
    }
}

/// One item's page: the registry's player for its shape, or an honest
/// "can't play" state. Each player owns what happens sideways.
struct PlayerPageView: View {
    let output: Output

    var body: some View {
        if let player = PlayerRegistry.standard.player(for: output) {
            player
        } else {
            let style = output.type.style
            EmptyStateView(
                icon: style.icon,
                title: output.title,
                message: style.isKnown
                    ? "This build can't play a \(style.label) yet."
                    : "This build doesn't know the \(style.label) format yet."
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// What the root presents full-screen: resolves the queue `AppState` holds
/// (or the default for the output) and plays it.
struct PresentedPlayerView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var store: OutputStore

    var body: some View {
        if let id = appState.presentedOutputID, let start = store.output(forID: id) {
            let queue = appState.presentedQueue
            PlayerShellView(
                outputs: outputs(for: start, queue: queue),
                ordering: OutputOrderings.ordering(forID: queue?.orderingID ?? OutputOrderings.defaultOrdering.id),
                startID: id,
                onClose: { appState.dismissPlayer() }
            )
        } else {
            Color.clear.onAppear { appState.dismissPlayer() }
        }
    }

    /// The queue's outputs, or by default the output's project (playable
    /// types only), or just the output itself for a single.
    private func outputs(for start: Output, queue: PlayerQueue?) -> [Output] {
        var list: [Output]
        if let queue {
            list = queue.outputIDs.compactMap { store.output(forID: $0) }
        } else if let projectID = start.projectID {
            list = store.outputs(inProject: projectID).filter { PlayerRegistry.standard.canPlay($0.type) }
        } else {
            list = []
        }
        if !list.contains(where: { $0.id == start.id }) { list.append(start) }
        return list
    }
}
