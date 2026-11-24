import SwiftUI

/// The output card, used by Home (continue, singles), Library (gallery /
/// list / compact) and project screens. The output type is the primary
/// badge; the source kind drives the placeholder art (DECISIONS.md #4).
struct OutputCardView: View {

    enum Style {
        /// Masonry-friendly card whose media adapts to the source kind.
        case gallery
        /// Full-width row: thumb, title, subtitle, type badge, time.
        case list
        /// Minimal one-line row.
        case compact
        /// Fixed-height tile for horizontal rows: title, type badge, one meta line.
        case tile
    }

    let output: Output
    let style: Style

    init(_ output: Output, style: Style = .gallery) {
        self.output = output
        self.style = style
    }

    var body: some View {
        switch style {
        case .gallery: galleryCard
        case .list: listRow
        case .compact: compactRow
        case .tile: tileCard
        }
    }

    private var kind: SourceKindStyle { output.sourceKind.style }

    // MARK: - Gallery

    private var galleryCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            galleryMedia

            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
                galleryTypedContent

                if output.sourceKind != .quote {
                    Text(output.title)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .lineLimit(2)
                }

                if let degraded = output.degradedCardState {
                    DegradedStateChip(state: degraded)
                }

                galleryFooter
            }
            .padding(.horizontal, OpenSourcebookTheme.Spacing.sm + 2)
            .padding(.vertical, OpenSourcebookTheme.Spacing.sm)
        }
        .background(output.sourceKind == .quote ? OpenSourcebookTheme.Colors.primaryGhost : OpenSourcebookTheme.Colors.surface)
        .openSourcebookCardStyle()
    }

    /// The first real image carried by the output's blocks (hero, figure,
    /// image, clip poster, link-preview image), resolved against the engine
    /// for `/v1/assets/<id>` paths.
    private var remoteImageURL: URL? {
        for block in output.allBlocks {
            switch block {
            case .hero(let url, _, _):
                if let resolved = AssetURLResolver.resolve(url) { return resolved }
            case .figure(let url, _, _, _):
                if let resolved = AssetURLResolver.resolve(url) { return resolved }
            case .image(let url, _, _):
                if let resolved = AssetURLResolver.resolve(url) { return resolved }
            case .clip(_, _, _, _, let posterURL, _):
                if let resolved = AssetURLResolver.resolve(posterURL) { return resolved }
            case .linkPreview(_, _, _, _, let imageURL):
                if let resolved = AssetURLResolver.resolve(imageURL) { return resolved }
            default:
                continue
            }
        }
        return nil
    }

    private func cardMedia(height: CGFloat) -> some View {
        RemoteCardThumbnail(url: remoteImageURL, style: kind, height: height)
    }

    @ViewBuilder
    private var galleryMedia: some View {
        switch output.sourceKind {
        case .quote, .thread, .note, .meeting:
            EmptyView()
        case .video:
            VideoCardThumbnail(youtubeID: output.firstYouTubeID, style: kind, height: 140)
                .overlay { PlayBadge() }
                .overlay(alignment: .bottomTrailing) {
                    if let duration = output.durationText { MediaBadge(text: duration) }
                }
        case .podcast:
            MediaPlaceholder(style: kind, height: 120, showsIcon: false)
                .overlay {
                    WaveformPlaceholder()
                        .padding(.horizontal, OpenSourcebookTheme.Spacing.lg)
                }
                .overlay(alignment: .bottomTrailing) {
                    if let duration = output.durationText { MediaBadge(text: duration) }
                }
        case .paper:
            DocumentPlaceholder()
                .frame(height: 110)
                .overlay(alignment: .bottomTrailing) {
                    if let duration = output.durationText { MediaBadge(text: duration) }
                }
        case .image:
            cardMedia(height: 170)
        case .recipe:
            cardMedia(height: 150)
        case .travel:
            cardMedia(height: 140)
        case .article:
            cardMedia(height: 130)
        case .spreadsheet, .other:
            cardMedia(height: 110)
        case .link:
            cardMedia(height: 100)
        }
    }

    @ViewBuilder
    private var galleryTypedContent: some View {
        switch output.sourceKind {
        case .quote:
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
                Text("\u{201C}")
                    .font(.system(size: 34, weight: .heavy))
                    .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                    .frame(height: 24, alignment: .top)
                Text(output.excerpt ?? output.title)
                    .font(.system(size: 15, weight: .semibold, design: .serif))
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .lineLimit(5)
                    .fixedSize(horizontal: false, vertical: true)
                if let author = output.author {
                    Text("— \(author)")
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                }
            }
        case .thread:
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
                AuthorRow(name: output.author ?? output.subtitle)
                if let excerpt = output.excerpt {
                    Text(excerpt)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .lineLimit(3)
                }
            }
        case .recipe:
            HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                if let duration = output.durationText {
                    MetaChip(icon: "clock", text: duration)
                }
            }
        case .note, .meeting, .paper, .article, .link, .podcast, .video, .travel, .image, .spreadsheet, .other:
            if let excerpt = output.excerpt {
                Text(excerpt)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .lineLimit(3)
            }
        }
    }

    private var galleryFooter: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            TypeBadge(output.type, showsLabel: false)
            Text(footerMeta)
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                .lineLimit(1)
            Spacer(minLength: OpenSourcebookTheme.Spacing.xs)
            Image(systemName: kind.icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(kind.color)
        }
        .padding(.top, OpenSourcebookTheme.Spacing.xxs)
    }

    private var footerMeta: String {
        var parts = [output.createdAt.openSourcebookRelativeDescription]
        if ItemShape(output.type) == .byte, !output.allBlocks.isEmpty {
            let count = output.screens.count
            parts.append(count == 1 ? "1 bit" : "\(count) bits")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: - Tile

    /// Same height for every output, so a horizontal row never grows to the
    /// tallest card in it.
    private var tileCard: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            Text(output.title)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .lineLimit(2, reservesSpace: true)
            Spacer(minLength: 0)
            galleryFooter
        }
        .padding(.horizontal, OpenSourcebookTheme.Spacing.sm + 2)
        .padding(.vertical, OpenSourcebookTheme.Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .frame(height: 96)
        .background(OpenSourcebookTheme.Colors.surface)
        .openSourcebookCardStyle()
    }

    // MARK: - List

    private var listRow: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            cardMedia(height: 52)
                .frame(width: 52)
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))

            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
                Text(output.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .lineLimit(2)
                Text(output.subtitle)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .lineLimit(1)
                if let degraded = output.degradedCardState {
                    DegradedStateChip(state: degraded)
                        .padding(.top, OpenSourcebookTheme.Spacing.xxs)
                }
            }

            Spacer(minLength: OpenSourcebookTheme.Spacing.xs)

            VStack(alignment: .trailing, spacing: OpenSourcebookTheme.Spacing.xxs) {
                TypeBadge(output.type, showsLabel: false)
                Text(output.createdAt.openSourcebookRelativeDescription)
                    .font(OpenSourcebookTheme.Fonts.label)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.sm)
        .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)
    }

    // MARK: - Compact

    private var compactRow: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            let style = output.type.style
            Image(systemName: style.icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(style.color)
                .frame(width: 30, height: 30)
                .background(style.softColor)
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r8, style: .continuous))

            Text(output.title)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .lineLimit(1)

            Spacer(minLength: OpenSourcebookTheme.Spacing.xs)

            if let degraded = output.degradedCardState {
                Image(systemName: degraded.icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .accessibilityLabel(degraded.label)
                    .accessibilityIdentifier("degraded-state-chip")
            }

            Text(output.createdAt.openSourcebookRelativeDescription)
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        }
        .padding(.horizontal, OpenSourcebookTheme.Spacing.sm)
        .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
    }
}

extension Date {
    /// "2h ago", "yesterday", "Nov 3". Cards use this instead of a stored string.
    var openSourcebookRelativeDescription: String {
        let interval = Date.now.timeIntervalSince(self)
        if interval < 60 { return "just now" }
        if interval < 86_400 * 2 {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .abbreviated
            return formatter.localizedString(for: self, relativeTo: .now)
        }
        return formatted(.dateTime.month(.abbreviated).day())
    }
}

// MARK: - Degraded-state honesty chip

/// An output's honest shallow state. Non-nil means the output is shallow by
/// necessity, and the card says so.
struct DegradedCardState: Equatable, Sendable {
    let label: String
    let icon: String
}

extension Output {
    /// The honest state to show on this output's card, if any. Save-only
    /// captures read as what they are, a kept link, not a generated output;
    /// tiny or known-degraded extractions read as metadata-only.
    var degradedCardState: DegradedCardState? {
        if isSaveOnly || density == .saveOnly {
            return sourceDomain != nil || sourceKind == .link
                ? DegradedCardState(label: "Saved link", icon: "link")
                : DegradedCardState(label: "Saved only", icon: "bookmark")
        }
        if density == .tiny || hasDegradedTag("extraction-empty") {
            return DegradedCardState(label: "Metadata only", icon: "doc.text")
        }
        if hasDegradedTag("failed") {
            return DegradedCardState(label: "Partial", icon: "circle.lefthalf.filled")
        }
        return nil
    }

    private func hasDegradedTag(_ tag: String) -> Bool {
        tags.contains { $0.caseInsensitiveCompare(tag) == .orderedSame }
    }
}

/// Small neutral chip stating an output's honest shallow state ("Saved link",
/// "Metadata only", "Partial"). Deliberately muted — informative, never an
/// alarm. Matches the `MetaChip` idiom used inside gallery cards.
struct DegradedStateChip: View {
    let state: DegradedCardState

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: state.icon)
                .font(.system(size: 9, weight: .semibold))
            Text(state.label)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(OpenSourcebookTheme.Colors.fill)
        .clipShape(Capsule())
        .accessibilityIdentifier("degraded-state-chip")
    }
}

// MARK: - Placeholder building blocks

/// Rounded-gradient media stand-in with the type's SF Symbol (no real images exist yet).
struct MediaPlaceholder: View {
    let style: SourceKindStyle
    var height: CGFloat = 120
    var showsIcon: Bool = true

    var body: some View {
        ZStack {
            LinearGradient(colors: style.gradient,
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            if showsIcon {
                Image(systemName: style.icon)
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.9))
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .clipped()
    }
}

/// White "document" art — stacked lines, like the paper card in the sketch.
private struct DocumentPlaceholder: View {
    private let widths: [CGFloat] = [0.55, 0.92, 0.88, 0.94, 0.70, 0.90, 0.60]

    var body: some View {
        GeometryReader { geo in
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(widths.enumerated()), id: \.offset) { index, fraction in
                    RoundedRectangle(cornerRadius: 3)
                        .fill(index == 0 ? OpenSourcebookTheme.Colors.muted.opacity(0.6) : OpenSourcebookTheme.Colors.border)
                        .frame(width: geo.size.width * fraction, height: index == 0 ? 7 : 5)
                }
            }
            .padding(OpenSourcebookTheme.Spacing.sm)
        }
        .background(OpenSourcebookTheme.Colors.surface)
    }
}

/// Deterministic bar waveform used on podcast cards.
struct WaveformPlaceholder: View {
    var barCount: Int = 26
    var color: Color = .white

    var body: some View {
        HStack(alignment: .center, spacing: 2.5) {
            ForEach(0..<barCount, id: \.self) { index in
                RoundedRectangle(cornerRadius: 2)
                    .fill(color.opacity(0.85))
                    .frame(height: height(for: index))
            }
        }
        .frame(height: 44)
    }

    private func height(for index: Int) -> CGFloat {
        let i = Double(index)
        let value = abs(sin(i * 1.7) * 0.6 + sin(i * 0.5 + 1.3) * 0.4)
        return 6 + value * 36
    }
}

/// Real YouTube thumbnail for video gallery cards, fetched from i.ytimg.com.
/// Falls back to the type's gradient + icon while loading or on failure.
private struct VideoCardThumbnail: View {
    let youtubeID: String?
    let style: SourceKindStyle
    var height: CGFloat = 140

    var body: some View {
        MediaPlaceholder(style: style, height: height)
            .overlay {
                if let youtubeID,
                   let url = URL(string: "https://i.ytimg.com/vi/\(youtubeID)/hqdefault.jpg") {
                    AsyncImage(url: url) { phase in
                        if case .success(let image) = phase {
                            image.resizable().scaledToFill()
                        }
                    }
                }
            }
            .clipped()
    }
}

/// Real image thumbnail for gallery/list cards, sourced from the output's own
/// blocks. The gradient placeholder owns the frame and the image is an
/// overlay on it — an overlay can never outgrow its base, so a loaded image
/// can't stretch the card (the ZStack sibling pattern could).
private struct RemoteCardThumbnail: View {
    let url: URL?
    let style: SourceKindStyle
    var height: CGFloat = 120

    var body: some View {
        MediaPlaceholder(style: style, height: height)
            .overlay {
                if let url {
                    AsyncImage(url: url) { phase in
                        if case .success(let image) = phase {
                            image.resizable().scaledToFill()
                        }
                    }
                }
            }
            .clipped()
    }
}

/// Frosted circular play button for video cards.
private struct PlayBadge: View {
    var body: some View {
        Circle()
            .fill(.white.opacity(0.92))
            .frame(width: 34, height: 34)
            .overlay {
                Image(systemName: "play.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .offset(x: 1)
            }
            .shadow(color: .black.opacity(0.3), radius: 4, x: 0, y: 2)
    }
}

/// Dark pill pinned to media corners (durations, page counts).
private struct MediaBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.black.opacity(0.75))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .padding(8)
    }
}

/// Small neutral chip (e.g. "30 min", "Easy") used inside gallery cards.
private struct MetaChip: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 9, weight: .semibold))
            Text(text)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(OpenSourcebookTheme.Colors.text)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(OpenSourcebookTheme.Colors.fill)
        .clipShape(Capsule())
    }
}

/// Bulleted meta line used by note and meeting cards.
private struct BulletLine: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: OpenSourcebookTheme.Spacing.xs) {
            Circle()
                .fill(OpenSourcebookTheme.Colors.muted.opacity(0.6))
                .frame(width: 4, height: 4)
                .padding(.top, 6)
            Text(text)
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Initials avatar + name row used by thread cards.
private struct AuthorRow: View {
    let name: String

    var body: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            Circle()
                .fill(OpenSourcebookTheme.Colors.primary)
                .frame(width: 26, height: 26)
                .overlay {
                    Text(initials)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                }
            Text(name)
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .lineLimit(1)
        }
    }

    private var initials: String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined()
    }
}


#Preview("Gallery") {
    ScrollView {
        LazyVStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            OutputCardView(Output(title: "Attention is all you need", subtitle: "arxiv.org", sourceKind: .paper, excerpt: "The transformer replaces recurrence with attention.", blocks: [.heading("Hi")]))
            OutputCardView(Output(type: FormatCatalog.bundled.formats[0].id, title: "Echelon → RREF", subtitle: "Lay §1.2", sourceKind: .article, excerpt: "Row reduction in six screens."))
            OutputCardView(Output(title: "Saved link", subtitle: "example.com", sourceKind: .link, sourceDomain: "example.com", isSaveOnly: true), style: .list)
            OutputCardView(Output(title: "Lecture 9", subtitle: "recording", sourceKind: .podcast), style: .compact)
        }
        .padding()
    }
    .background(OpenSourcebookTheme.Colors.background)
}
