import SwiftUI

/// The Feed: playable items one at a time, in the order of a swappable
/// algorithm (DECISIONS.md #6), through the same player shell as a plan.
struct FeedView: View {
    @EnvironmentObject private var store: OutputStore
    @AppStorage("feed.orderingID") private var orderingID = OutputOrderings.defaultOrdering.id

    private var ordering: any OutputOrdering { OutputOrderings.ordering(forID: orderingID) }

    private var playable: [Output] {
        store.outputs.filter { PlayerRegistry.standard.playsInFeed($0.type) }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if playable.isEmpty {
                EmptyStateView(
                    icon: "infinity",
                    title: "Nothing to play",
                    message: "Bytes you capture will stream here."
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                PlayerShellView(outputs: playable, ordering: ordering, marksOpened: false)
                    .id(ordering.id)
            }
        }
        .background(OpenSourcebookTheme.Colors.background)
        .navigationBarHidden(true)
    }

    private var header: some View {
        HStack {
            Text("Feed")
                .font(OpenSourcebookTheme.Fonts.title)
                .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
            Spacer()
            Menu {
                Picker("Order", selection: $orderingID) {
                    ForEach(OutputOrderings.all, id: \.id) { option in
                        Text(option.label).tag(option.id)
                    }
                }
            } label: {
                Label(ordering.label, systemImage: "arrow.up.arrow.down")
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .padding(.horizontal, OpenSourcebookTheme.Spacing.sm)
                    .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
                    .background(OpenSourcebookTheme.Colors.surface)
                    .clipShape(Capsule())
                    .overlay(Capsule().stroke(OpenSourcebookTheme.Colors.border, lineWidth: 1))
            }
            .accessibilityLabel("Feed order")
        }
        .padding(.horizontal, OpenSourcebookTheme.Spacing.lg)
        .padding(.vertical, OpenSourcebookTheme.Spacing.sm)
    }
}

#Preview {
    NavigationStack { FeedView() }
        .environmentObject(OutputStore())
        .environmentObject(AppState())
}
