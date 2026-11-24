import SwiftUI

/// Blocks bound to media the engine harvested into asset storage (PDF figures,
/// article images, timed video clips). Every image/poster URL goes through
/// `AssetURLResolver`, so engine-relative `/v1/assets/<id>` paths load against
/// the configured engine endpoint and absolute URLs pass through untouched.

// MARK: - Figure

/// Extracted figure/diagram: aspect-fit image with the gradient + SF Symbol
/// fallback while loading/offline, caption below, and a small tertiary
/// provenance line (e.g. "Figure 3, page 12") when `credit` is present.
struct FigureBlockView: View {
    let url: String
    let caption: String?
    let credit: String?
    let systemIcon: String?

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            Group {
                if let imageURL = AssetURLResolver.resolve(url) {
                    AsyncImage(url: imageURL) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                        default:
                            fallback
                        }
                    }
                } else {
                    fallback
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 220)
            .background(OpenSourcebookTheme.Colors.fill)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r20, style: .continuous))

            if let caption {
                Text(caption)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
            if let credit {
                Text(credit)
                    .font(OpenSourcebookTheme.Fonts.label)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted.opacity(0.8))
            }
        }
    }

    private var fallback: some View {
        MediaAssetFallbackView(systemIcon: systemIcon ?? "photo")
    }
}

// MARK: - Gallery

/// Lazy grid of extracted images honoring `columns` (2 or 3, default 2).
/// Captions overlay the cell's bottom edge; tapping a cell opens a full-size
/// zoom sheet.
struct GalleryBlockView: View {
    let images: [GalleryItem]
    let columns: Int?

    @State private var zoomed: ZoomedGalleryImage?

    /// The contract allows 2 or 3 columns; anything else falls back to 2.
    private var columnCount: Int { columns == 3 ? 3 : 2 }

    private var gridColumns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: OpenSourcebookTheme.Spacing.xs), count: columnCount)
    }

    var body: some View {
        LazyVGrid(columns: gridColumns, spacing: OpenSourcebookTheme.Spacing.xs) {
            ForEach(Array(images.enumerated()), id: \.offset) { _, item in
                cell(for: item)
            }
        }
        .sheet(item: $zoomed) { zoomed in
            GalleryZoomView(item: zoomed.item)
        }
    }

    private func cell(for item: GalleryItem) -> some View {
        Button {
            zoomed = ZoomedGalleryImage(item: item)
            OpenSourcebookHaptics.lightImpact()
        } label: {
            Color.clear
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    if let imageURL = AssetURLResolver.resolve(item.url) {
                        AsyncImage(url: imageURL) { phase in
                            switch phase {
                            case .success(let image):
                                image
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                            default:
                                MediaAssetFallbackView(systemIcon: "photo")
                            }
                        }
                    } else {
                        MediaAssetFallbackView(systemIcon: "photo")
                    }
                }
                .overlay(alignment: .bottom) {
                    if let caption = item.caption {
                        Text(caption)
                            .font(OpenSourcebookTheme.Fonts.label)
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .padding(OpenSourcebookTheme.Spacing.xs)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                LinearGradient(colors: [.clear, .black.opacity(0.6)],
                                               startPoint: .top, endPoint: .bottom)
                            )
                    }
                }
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.caption ?? "Image")
    }
}

/// `GalleryItem` is shared with the engine contract and stays non-Identifiable;
/// this wrapper keys the zoom sheet by URL.
private struct ZoomedGalleryImage: Identifiable {
    let item: GalleryItem
    var id: String { item.url }
}

/// Full-size gallery image on a dark backdrop; swipe down to dismiss.
private struct GalleryZoomView: View {
    let item: GalleryItem

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let imageURL = AssetURLResolver.resolve(item.url) {
                AsyncImage(url: imageURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                    default:
                        ProgressView()
                            .tint(.white)
                    }
                }
            }
        }
        .overlay(alignment: .bottom) {
            if let caption = item.caption {
                Text(caption)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(.white)
                    .padding(OpenSourcebookTheme.Spacing.lg)
            }
        }
    }
}

// MARK: - Clip

/// Timed video clip card: poster (or dark facade) with a play badge, a
/// platform chip, and a "1:23 – 2:20" time-range badge. Tap opens the source —
/// YouTube URLs deep-link to `startSeconds`.
struct ClipBlockView: View {
    let url: String
    let startSeconds: Int
    let endSeconds: Int?
    let title: String?
    let posterURL: String?
    let platform: ClipPlatform?

    @Environment(\.openURL) private var openURL

    /// Poster to render: the engine-harvested asset when present, otherwise —
    /// for YouTube clips — the platform's canonical thumbnail derived from the
    /// video ID (the same facade `VideoBlockView` uses). The engine deliberately
    /// strips duplicate `posterURL`s across clips of one video, so a missing
    /// `posterURL` is normal, not an error state.
    private var posterImageURL: URL? {
        if let poster = AssetURLResolver.resolve(posterURL) { return poster }
        if platform == .youtube, let id = Self.youtubeID(from: url) {
            return URL(string: "https://i.ytimg.com/vi/\(id)/hqdefault.jpg")
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            Button {
                openClip()
                OpenSourcebookHaptics.lightImpact()
            } label: {
                ZStack {
                    if let poster = posterImageURL {
                        AsyncImage(url: poster) { phase in
                            switch phase {
                            case .success(let image):
                                image.resizable().aspectRatio(contentMode: .fill)
                            default:
                                posterFallback
                            }
                        }
                    } else {
                        posterFallback
                    }

                    Circle()
                        .fill(.white.opacity(0.92))
                        .frame(width: 52, height: 52)
                        .overlay {
                            Image(systemName: "play.fill")
                                .font(.system(size: 20))
                                .foregroundStyle(Color(hex: 0x111111))
                                .offset(x: 2)
                        }
                        .shadow(color: .black.opacity(0.3), radius: 8, x: 0, y: 3)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .topLeading) {
                    if let platform {
                        badge(platform.displayName.uppercased())
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    badge(timeRangeText, monospaced: true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Play clip")
            .aspectRatio(16.0 / 9.0, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r20, style: .continuous))

            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .lineLimit(2)
            }
        }
    }

    // MARK: Opening

    /// YouTube deep-links to `startSeconds`; other platforms open the plain URL.
    private func openClip() {
        guard var target = AssetURLResolver.resolve(url) else { return }
        if platform == .youtube,
           var components = URLComponents(url: target, resolvingAgainstBaseURL: false) {
            var queryItems = components.queryItems ?? []
            queryItems.append(URLQueryItem(name: "t", value: "\(max(0, startSeconds))"))
            components.queryItems = queryItems
            if let deepLinked = components.url { target = deepLinked }
        }
        openURL(target)
    }

    // MARK: Badges & formatting

    private var timeRangeText: String {
        let start = Self.format(startSeconds)
        guard let endSeconds else { return start }
        return "\(start) – \(Self.format(endSeconds))"
    }

    private func badge(_ text: String, monospaced: Bool = false) -> some View {
        Text(text)
            .font(monospaced ? .system(size: 11, weight: .medium) : OpenSourcebookTheme.Fonts.label)
            .tracking(monospaced ? 0 : 1)
            .monospacedDigit()
            .foregroundStyle(.white)
            .padding(.horizontal, OpenSourcebookTheme.Spacing.xs)
            .padding(.vertical, OpenSourcebookTheme.Spacing.xxs)
            .background(.black.opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r8, style: .continuous))
            .padding(OpenSourcebookTheme.Spacing.xs)
    }

    private var posterFallback: some View {
        LinearGradient(colors: [Color(hex: 0x1E293B), Color(hex: 0x0F172A)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    private static func format(_ seconds: Int) -> String {
        let total = max(0, seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    /// Video ID out of the common YouTube URL shapes (watch, youtu.be,
    /// shorts, embed, live) — mirrors `PlatformEmbed.youtubeID`.
    private static func youtubeID(from rawURL: String) -> String? {
        guard let url = URL(string: rawURL), let host = url.host?.lowercased() else { return nil }
        if host.contains("youtu.be") {
            let id = url.path.dropFirst()
            return id.isEmpty ? nil : String(id)
        }
        guard host.contains("youtube.com") else { return nil }
        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let id = components.queryItems?.first(where: { $0.name == "v" })?.value,
           !id.isEmpty {
            return id
        }
        for prefix in ["/shorts/", "/embed/", "/live/"] {
            if url.path.hasPrefix(prefix) {
                let id = String(url.path.dropFirst(prefix.count))
                return id.isEmpty ? nil : id
            }
        }
        return nil
    }
}

// MARK: - Shared

/// Gradient + SF Symbol placeholder used while an asset loads or when it fails,
/// mirroring `ImageBlockView`'s fallback.
private struct MediaAssetFallbackView: View {
    let systemIcon: String

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: 0xBAE6FD), Color(hex: 0x6C5CE7)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Image(systemName: systemIcon)
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(.white.opacity(0.9))
        }
    }
}

private extension ClipPlatform {
    var displayName: String {
        switch self {
        case .youtube: return "YouTube"
        case .tiktok: return "TikTok"
        case .instagram: return "Instagram"
        case .vimeo: return "Vimeo"
        case .web: return "Web"
        }
    }
}
