import SwiftUI

/// What a citation needs from outside the payload: a source's name, its text
/// and where a harvested picture lives. Backed by the Studio store in the
/// app; empty in previews and wherever no engine is set up, where a chip
/// still shows "Source n" and its quote.
struct CiteSources {
    var studio: StudioStore?

    @MainActor func name(_ sourceID: String) -> String? { studio?.sourceName(sourceID) }

    @MainActor func detail(_ sourceID: String) async -> StudioSourceDetail? {
        await studio?.sourceDetail(sourceID)
    }

    @MainActor func assetURL(_ assetID: String) -> URL? { studio?.client.assetURL(assetID) }
}

private struct CiteSourcesKey: EnvironmentKey {
    static let defaultValue = CiteSources()
}

extension EnvironmentValues {
    var citeSources: CiteSources {
        get { self[CiteSourcesKey.self] }
        set { self[CiteSourcesKey.self] = newValue }
    }
}

/// Where a bit's (or a question's) claims come from, drawn quietly: one small
/// chip per source, naming it and, when all its cites are on one page or
/// moment, where. Tapping one shows the cited spots.
struct CiteChips: View {
    @Environment(\.citeSources) private var sources
    let cites: [JSONValue]

    @State private var opened: CiteGroup?

    var body: some View {
        let groups = CiteGroup.groups(cites)
        if !groups.isEmpty {
            // One chip per line: a bit rarely cites more than two sources, and
            // a plain stack keeps the bit's fit-to-screen measuring stable.
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
                ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                    Button {
                        opened = group
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "text.quote")
                                .font(.system(size: 10, weight: .semibold))
                            Text(group.chipLabel(sourceName: sources.name(group.sourceId), position: index))
                                .lineLimit(1)
                        }
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.mutedText)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(OpenSourcebookTheme.Colors.fill)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Source: \(group.chipLabel(sourceName: sources.name(group.sourceId), position: index))")
                    .accessibilityHint("Shows where this comes from")
                    .accessibilityIdentifier("cite-chip")
                }
            }
            .sheet(item: $opened) { group in
                let position = groups.firstIndex(of: group) ?? 0
                CiteSheet(group: group, position: position)
                    .presentationDetents([.medium, .large])
                    .preferredColorScheme(.light)
            }
        }
    }
}

/// The cited spots of one source: each with what kind of spot it is, where
/// it is, and as much of it as the phone can show (the passage around the
/// quote, a picture, a moment).
struct CiteSheet: View {
    @Environment(\.citeSources) private var sources
    @Environment(\.dismiss) private var dismiss
    let group: CiteGroup
    let position: Int

    @State private var detail: StudioSourceDetail?
    @State private var isLoading = true

    private var title: String {
        detail?.displayTitle ?? sources.name(group.sourceId) ?? "Source \(position + 1)"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.lg) {
                    ForEach(Array(group.cites.enumerated()), id: \.offset) { _, cite in
                        CiteSpotView(cite: cite, text: detail?.extraction?.text, isLoading: isLoading,
                                     assetURL: cite.assetId.flatMap { sources.assetURL($0) })
                    }
                    if let url = detail?.source.url, let link = URL(string: url) {
                        Link(destination: link) {
                            Label("Open the source", systemImage: "arrow.up.right.square")
                                .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        }
                        .tint(OpenSourcebookTheme.Colors.primary)
                    }
                }
                .padding(OpenSourcebookTheme.Spacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(OpenSourcebookTheme.Colors.background)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .accessibilityIdentifier("cite-sheet")
        .task(id: group.sourceId) {
            detail = await sources.detail(group.sourceId)
            isLoading = false
        }
    }
}

/// One cited spot.
private struct CiteSpotView: View {
    let cite: Cite
    let text: String?
    let isLoading: Bool
    let assetURL: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            HStack(spacing: 6) {
                Image(systemName: cite.spot.icon)
                Text([cite.spot.label, cite.place].compactMap { $0 }.joined(separator: " · "))
            }
            .font(OpenSourcebookTheme.Fonts.label)
            .foregroundStyle(OpenSourcebookTheme.Colors.muted)

            if cite.spot.isPicture, let assetURL {
                AsyncImage(url: assetURL) { image in
                    image.resizable().scaledToFit()
                } placeholder: {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                }
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
            }
            if cite.spot.drawnAs == .moment, let start = cite.locator?.startMs {
                Text("At \(Cite.clock(start)) in the recording.")
                    .font(OpenSourcebookTheme.Fonts.body)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }

            if let text, let excerpt = CiteExcerpt.make(text: text, cite: cite) {
                Text(excerptText(excerpt))
                    .font(OpenSourcebookTheme.Fonts.body)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("cite-excerpt")
            } else if let quote = cite.quote {
                Text("“\(quote)”")
                    .font(OpenSourcebookTheme.Fonts.body)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("cite-quote")
                if isLoading {
                    ProgressView().controlSize(.small)
                }
            } else if !cite.spot.isPicture && cite.spot.drawnAs != .moment && !isLoading {
                Text("The engine didn't keep the words for this spot.")
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OpenSourcebookTheme.Colors.surface)
        .openSourcebookCardStyle()
    }

    /// The passage in grey with the cited words marked.
    private func excerptText(_ excerpt: CiteExcerpt) -> AttributedString {
        var before = AttributedString(excerpt.before)
        var marked = AttributedString(excerpt.marked)
        marked.foregroundColor = OpenSourcebookTheme.Colors.text
        marked.backgroundColor = OpenSourcebookTheme.Colors.accentSoft
        marked.font = OpenSourcebookTheme.Fonts.bodySemibold
        before.append(marked)
        before.append(AttributedString(excerpt.after))
        return before
    }
}
