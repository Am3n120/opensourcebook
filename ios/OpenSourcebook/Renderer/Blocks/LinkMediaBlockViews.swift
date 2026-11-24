import SwiftUI
import Combine
import MapKit
import AVFoundation
#if canImport(UIKit)
import WebKit
#endif

/// Renderers for the link & media blocks: third-party `embed`, rich
/// `linkPreview`, swipeable `carousel`, MapKit `map`, full-width `hero`
/// cover, and the timed `audioClip` segment player. Image/media URLs go
/// through `AssetURLResolver` so engine-relative `/v1/assets/<id>` paths
/// load against the configured engine endpoint.

// MARK: - Embed

/// Third-party social/media embed card. Loads the platform's OFFICIAL embed
/// (tiktok.com/embed, instagram.com/p/…/embed, platform.twitter.com,
/// threads.net, Pinterest's pin widget, redditmedia, open.spotify.com/embed,
/// youtube-nocookie.com/embed) or verbatim oEmbed HTML for generic web embeds
/// in a WKWebView under a platform chrome label. When the embed can't load
/// (offline, bad URL) the card degrades to a link-preview fallback.
struct EmbedBlockView: View {
    let platform: EmbedPlatform
    let url: String
    let title: String?
    /// Verbatim HTML returned by the engine's generic oEmbed tier. Named
    /// platforms ignore this field and continue using their official loaders.
    let html: String?

    @Environment(\.openURL) private var openURL
    @State private var isLoading = true
    @State private var failed = false
    /// Measured embed content height (nil until the webview reports it).
    @State private var contentHeight: CGFloat?

    private var embedLoad: EmbedLoad? { PlatformEmbed.load(for: platform, url: url, html: html) }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            card

            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .lineLimit(2)
            }
        }
    }

    @ViewBuilder
    private var card: some View {
        #if canImport(UIKit)
        if failed || embedLoad == nil {
            fallbackCard
        } else {
            embedCard
        }
        #else
        fallbackCard
        #endif
    }

    /// Degrades to the link-preview look: domain, title, open link.
    private var fallbackCard: some View {
        LinkPreviewBlockView(url: url,
                             title: title ?? platform.displayName,
                             domain: platform.domain(of: url),
                             description: nil,
                             imageURL: nil)
    }

    private var chrome: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            Image(systemName: platform.systemIcon)
                .font(.system(size: 12, weight: .semibold))
            Text(platform.displayName.uppercased())
                .font(OpenSourcebookTheme.Fonts.label)
                .tracking(1)

            Spacer()

            Button {
                if let target = URL(string: url) { openURL(target) }
            } label: {
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12, weight: .bold))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open in \(platform.displayName)")
        }
        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
        .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
    }

    #if canImport(UIKit)
    private var embedCard: some View {
        VStack(spacing: 0) {
            chrome

            Rectangle()
                .fill(OpenSourcebookTheme.Colors.border)
                .frame(height: 1)

            ZStack {
                if isLoading {
                    ProgressView()
                        .tint(OpenSourcebookTheme.Colors.primary)
                }
                if let embedLoad {
                    EmbedWebView(load: embedLoad,
                                 onLoaded: { isLoading = false },
                                 onFailed: {
                                     isLoading = false
                                     failed = true
                                 },
                                 onHeight: { height in
                                     withAnimation(OpenSourcebookTheme.Motion.quick) { contentHeight = height }
                                 })
                }
            }
            .frame(maxWidth: .infinity)
            // YouTube keeps its cinematic 16:9; text/social embeds size to their
            // measured content (120pt floor, 480 cap so tall embeds can't
            // stretch the canvas). Pre-measurement fallbacks stay platform-tuned.
            .modifier(EmbedHeightModifier(platform: platform, contentHeight: contentHeight))
        }
        .openSourcebookCardStyle()
    }

    /// Platform-tuned frame for embeds: 16:9 for video, measured content
    /// height (floored/capped) for everything else.
    private struct EmbedHeightModifier: ViewModifier {
        let platform: EmbedPlatform
        let contentHeight: CGFloat?

        func body(content: Content) -> some View {
            if platform == .youtube {
                content.aspectRatio(16.0 / 9.0, contentMode: .fit)
            } else {
                content.frame(height: height)
            }
        }

        private var height: CGFloat {
            let fallback: CGFloat
            switch platform {
            case .tiktok, .instagram, .pinterest:
                fallback = 480 // tall media embeds
            default:
                fallback = 200 // text-ish embeds (x, threads, reddit, spotify, web)
            }
            guard let contentHeight else { return fallback }
            return min(max(contentHeight, 120), 480)
        }
    }
    #endif
}

/// What the embed webview loads: either the platform's embed URL directly
/// (so navigation-delegate failure detection covers offline), or HTML supplied
/// by a platform wrapper / the engine's generic oEmbed tier.
private enum EmbedLoad {
    case url(URL)
    case html(String, baseURL: URL?)
}

/// Builds each named platform's OFFICIAL embed target from a user-facing URL,
/// or loads the engine-returned oEmbed HTML for generic `.web` embeds.
private enum PlatformEmbed {
    static func load(for platform: EmbedPlatform, url rawURL: String, html: String? = nil) -> EmbedLoad? {
        guard let source = URL(string: rawURL), source.scheme != nil else { return nil }
        if platform == .web {
            // Generic web embeds have no safe per-platform URL fallback. The
            // engine emits a linkPreview when oEmbed is unavailable; a web
            // embed without returned HTML therefore follows the same path.
            guard let html, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return .html(html, baseURL: source)
        }
        switch platform {
        case .tiktok:
            if let id = pathValue(after: "video", in: source) ?? pathValue(after: "photo", in: source),
               let embedURL = URL(string: "https://www.tiktok.com/embed/v2/\(id)") {
                return .url(embedURL)
            }
            return .url(source)
        case .instagram:
            for segment in ["p", "reel", "reels", "tv"] {
                if let code = pathValue(after: segment, in: source) {
                    let kind = segment == "reels" ? "reel" : segment
                    if let embedURL = URL(string: "https://www.instagram.com/\(kind)/\(code)/embed") {
                        return .url(embedURL)
                    }
                }
            }
            return .url(source)
        case .x:
            if pathValue(after: "status", in: source) != nil {
                return xTweetLoad(sourceURL: source.absoluteString)
            }
            return .url(source)
        case .threads:
            if let embedURL = threadsEmbedURL(from: source) {
                return .url(embedURL)
            }
            return .url(source)
        case .pinterest:
            if let id = pathValue(after: "pin", in: source),
               let embedURL = URL(string: "https://assets.pinterest.com/ext/embed.html?id=\(id)") {
                return .url(embedURL)
            }
            return .url(source)
        case .reddit:
            let path = source.path
            if !path.isEmpty, path != "/",
               let embedURL = URL(string: "https://www.redditmedia.com\(path)?ref_source=embed&ref=share&embed=true") {
                return .url(embedURL)
            }
            return .url(source)
        case .spotify:
            let path = source.path
            if path.hasPrefix("/embed/") { return .url(source) }
            if source.pathComponents.count >= 3,
               let embedURL = URL(string: "https://open.spotify.com/embed\(path)") {
                return .url(embedURL)
            }
            return .url(source)
        case .youtube:
            if let id = youtubeID(from: source) {
                return youtubeLoad(id: id)
            }
            return .url(source)
        case .web:
            // Handled above so the switch remains exhaustive if the enum grows.
            return nil
        }
    }

    /// Value of the path component right after `segment` ("/@u/video/123" → "123").
    private static func pathValue(after segment: String, in url: URL) -> String? {
        let components = url.pathComponents
        guard let index = components.firstIndex(of: segment), index + 1 < components.count else { return nil }
        let value = components[index + 1]
        return value.isEmpty ? nil : value
    }

    /// threads.net/@user/post/<id> → threads.net/@user/post/<id>/embed.
    private static func threadsEmbedURL(from url: URL) -> URL? {
        let components = url.pathComponents
        guard let postIndex = components.firstIndex(of: "post"),
              postIndex >= 2, postIndex + 1 < components.count else { return nil }
        let user = components[postIndex - 1]
        let id = components[postIndex + 1]
        return URL(string: "https://www.threads.net/\(user)/post/\(id)/embed")
    }

    private static func youtubeID(from url: URL) -> String? {
        guard let host = url.host?.lowercased() else { return nil }
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

    /// YouTube rejects embeds whose referrer/origin is youtube.com itself
    /// (error 152-4) and embeds with no referrer at all (error 153); the
    /// documented embedder identity is the app's bundle ID — same pattern as
    /// `VideoBlockView`.
    private static func youtubeLoad(id: String) -> EmbedLoad {
        let bundleID = (Bundle.main.bundleIdentifier ?? "app.opensourcebook").lowercased()
        let origin = "https://\(bundleID)"
        let encodedOrigin = origin.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? origin
        let html = """
        <!doctype html>
        <html>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <meta name="referrer" content="strict-origin-when-cross-origin">
        <style>
          html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
          iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
        </style>
        </head>
        <body>
        <iframe src="https://www.youtube-nocookie.com/embed/\(id)?playsinline=1&rel=0&origin=\(encodedOrigin)"
                referrerpolicy="strict-origin-when-cross-origin"
                allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowfullscreen></iframe>
        </body>
        </html>
        """
        return .html(html, baseURL: URL(string: "\(origin)/"))
    }

    /// X's hosted embed page (Tweet.html) sizes itself to its container, which
    /// defeats content-height measurement. Our own wrapper page has no such
    /// sizing: body height tracks the widget, so the card hugs the tweet.
    private static func xTweetLoad(sourceURL: String) -> EmbedLoad {
        let html = """
        <!doctype html>
        <html>
        <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <meta name="referrer" content="strict-origin-when-cross-origin">
        <style>
          html, body { margin: 0; padding: 0; background: transparent; }
          .twitter-tweet { margin: 0 !important; }
        </style>
        </head>
        <body>
        <blockquote class="twitter-tweet" data-dnt="true"><a href="\(sourceURL)"></a></blockquote>
        <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>
        </body>
        </html>
        """
        return .html(html, baseURL: URL(string: "https://platform.twitter.com/"))
    }
}

#if canImport(UIKit)
/// WKWebView wrapper for platform embeds. Direct-URL loads let the navigation
/// delegate detect failures (offline → fallback card); YouTube goes through an
/// HTML iframe wrapper to control the referrer.
private struct EmbedWebView: UIViewRepresentable {
    let load: EmbedLoad
    let onLoaded: () -> Void
    let onFailed: () -> Void
    let onHeight: (CGFloat) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onLoaded: onLoaded, onFailed: onFailed, onHeight: onHeight) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        // Nested vertical scrolling fights the canvas; embeds fit their frame.
        webView.scrollView.isScrollEnabled = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.navigationDelegate = context.coordinator
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Load once — updateUIView fires on unrelated state changes.
        guard !context.coordinator.didStartLoad else { return }
        context.coordinator.didStartLoad = true
        switch load {
        case .url(let url):
            webView.load(URLRequest(url: url))
        case .html(let html, let baseURL):
            webView.loadHTMLString(html, baseURL: baseURL)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var didStartLoad = false
        private var didReport = false
        private let onLoaded: () -> Void
        private let onFailed: () -> Void
        private let onHeight: (CGFloat) -> Void

        init(onLoaded: @escaping () -> Void, onFailed: @escaping () -> Void, onHeight: @escaping (CGFloat) -> Void) {
            self.onLoaded = onLoaded
            self.onFailed = onFailed
            self.onHeight = onHeight
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Platform embed JS (widgets.js et al.) expands content after
            // didFinish, so measure on load, then twice more as it settles.
            reportHeight(webView)
            for delay in [0.8, 2.2] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self, weak webView] in
                    guard let webView else { return }
                    self?.reportHeight(webView)
                }
            }
            guard !didReport else { return }
            didReport = true
            onLoaded()
        }

        private func reportHeight(_ webView: WKWebView) {
            // Measure the widget element, not the page: embed pages often use
            // min-height:100vh, which makes body.scrollHeight echo the frame's
            // own height and defeats shrinking. twitter-widget covers X;
            // iframe/body cover the rest.
            let script = """
            (() => {
              const el = document.querySelector('twitter-widget')
                || document.querySelector('.twitter-tweet')
                || document.querySelector('iframe')
                || document.body;
              const h = el && el.getBoundingClientRect ? el.getBoundingClientRect().height : 0;
              return h || (document.body ? document.body.scrollHeight : 0);
            })()
            """
            webView.evaluateJavaScript(script) { [weak self] value, _ in
                guard let height = (value as? NSNumber)?.doubleValue, height > 0 else { return }
                DispatchQueue.main.async { self?.onHeight(CGFloat(height)) }
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(with: error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(with: error)
        }

        private func fail(with error: Error) {
            // -999 fires when embed JS triggers a cancelled navigation.
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            guard !didReport else { return }
            didReport = true
            onFailed()
        }
    }
}
#endif

// MARK: - Link preview

/// Rich unfurl card: optional thumbnail (via `AssetURLResolver`, gradient
/// fallback), title, 2-line description and a domain chip. Opens the URL on tap.
struct LinkPreviewBlockView: View {
    let url: String
    let title: String
    let domain: String
    let description: String?
    let imageURL: String?

    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            if let target = URL(string: url) { openURL(target) }
            OpenSourcebookHaptics.lightImpact()
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                if let imageURL {
                    thumbnail(for: imageURL)
                }

                VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
                    Text(title)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)

                    if let description {
                        Text(description)
                            .font(OpenSourcebookTheme.Fonts.caption)
                            .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                        Text(domain.uppercased())
                            .font(OpenSourcebookTheme.Fonts.label)
                            .tracking(1)
                            .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                            .lineLimit(1)
                            .padding(.horizontal, OpenSourcebookTheme.Spacing.xs)
                            .padding(.vertical, OpenSourcebookTheme.Spacing.xxs)
                            .background(OpenSourcebookTheme.Colors.primarySoft)
                            .clipShape(Capsule())

                        Spacer()

                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    }
                }
                .padding(OpenSourcebookTheme.Spacing.md)
            }
            .openSourcebookCardStyle()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open link: \(title)")
    }

    private func thumbnail(for rawURL: String) -> some View {
        Group {
            if let resolved = AssetURLResolver.resolve(rawURL) {
                AsyncImage(url: resolved) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    default:
                        LinkMediaFallbackView(systemIcon: "link")
                    }
                }
            } else {
                LinkMediaFallbackView(systemIcon: "link")
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 160)
        .clipped()
    }
}

// MARK: - Carousel

/// Horizontally swipeable strip of image cards (one card per page) with
/// captions overlaid on a bottom scrim and page indicator dots below.
struct CarouselBlockView: View {
    let items: [CarouselItem]

    @State private var currentIndex: Int? = 0

    var body: some View {
        VStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            ScrollView(.horizontal) {
                LazyHStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                        card(for: item)
                            .containerRelativeFrame(.horizontal)
                            .id(index)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollPosition(id: $currentIndex)
            .scrollIndicators(.hidden)

            if items.count > 1 {
                pageIndicator
            }
        }
    }

    private func card(for item: CarouselItem) -> some View {
        Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: 240)
            .overlay {
                if let imageURL = AssetURLResolver.resolve(item.url) {
                    AsyncImage(url: imageURL) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        default:
                            LinkMediaFallbackView(systemIcon: "photo")
                        }
                    }
                } else {
                    LinkMediaFallbackView(systemIcon: "photo")
                }
            }
            .overlay(alignment: .bottom) {
                if let caption = item.caption {
                    Text(caption)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(.white)
                        .lineLimit(2)
                        .padding(OpenSourcebookTheme.Spacing.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            LinearGradient(colors: [.clear, .black.opacity(0.65)],
                                           startPoint: .top, endPoint: .bottom)
                        )
                }
            }
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r20, style: .continuous))
    }

    private var pageIndicator: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.xxs) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, _ in
                Circle()
                    .fill(index == (currentIndex ?? 0) ? OpenSourcebookTheme.Colors.primary : OpenSourcebookTheme.Colors.border)
                    .frame(width: 6, height: 6)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }
}

// MARK: - Map

/// MapKit card with one pin per place. The region is fitted to the places
/// (padded so edge pins clear the card); tapping a pin toggles a callout
/// with the place's name and note.
struct MapBlockView: View {
    let title: String?
    let places: [MapPlace]

    @State private var selectedPlace: MapPlace? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }

            Map(initialPosition: .region(Self.region(fitting: places))) {
                ForEach(Array(places.enumerated()), id: \.offset) { _, place in
                    Annotation(place.name,
                               coordinate: CLLocationCoordinate2D(latitude: place.latitude,
                                                                  longitude: place.longitude),
                               anchor: .bottom) {
                        annotation(for: place)
                    }
                }
            }
            .frame(height: 240)
            .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r20, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r20, style: .continuous)
                    .stroke(OpenSourcebookTheme.Colors.border, lineWidth: 1)
            )
        }
    }

    private func annotation(for place: MapPlace) -> some View {
        VStack(spacing: OpenSourcebookTheme.Spacing.xxs) {
            if selectedPlace == place {
                VStack(alignment: .leading, spacing: 2) {
                    Text(place.name)
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    if let note = place.note {
                        Text(note)
                            .font(OpenSourcebookTheme.Fonts.caption)
                            .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(OpenSourcebookTheme.Spacing.xs)
                .frame(maxWidth: 200, alignment: .leading)
                .background(OpenSourcebookTheme.Colors.surface)
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous)
                        .stroke(OpenSourcebookTheme.Colors.border, lineWidth: 1)
                )
                .openSourcebookCardShadow()
            }

            Image(systemName: "mappin.circle.fill")
                .font(.system(size: 28))
                .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                .shadow(color: .black.opacity(0.2), radius: 3, x: 0, y: 2)
        }
        .onTapGesture {
            withAnimation(OpenSourcebookTheme.Motion.quick) {
                selectedPlace = selectedPlace == place ? nil : place
            }
            OpenSourcebookHaptics.lightImpact()
        }
        .accessibilityLabel(place.name)
    }

    /// Region spanning all places, padded 40% so edge pins clear the card;
    /// floored so a lone pin stays readable and clamped to a valid span.
    private static func region(fitting places: [MapPlace]) -> MKCoordinateRegion {
        guard let first = places.first else {
            return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 0, longitude: 0),
                                      span: MKCoordinateSpan(latitudeDelta: 30, longitudeDelta: 30))
        }
        var minLat = first.latitude
        var maxLat = first.latitude
        var minLon = first.longitude
        var maxLon = first.longitude
        for place in places.dropFirst() {
            minLat = min(minLat, place.latitude)
            maxLat = max(maxLat, place.latitude)
            minLon = min(minLon, place.longitude)
            maxLon = max(maxLon, place.longitude)
        }
        let center = CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2,
                                            longitude: (minLon + maxLon) / 2)
        let span = MKCoordinateSpan(latitudeDelta: min(max((maxLat - minLat) * 1.4, 0.02), 180),
                                    longitudeDelta: min(max((maxLon - minLon) * 1.4, 0.02), 360))
        return MKCoordinateRegion(center: center, span: span)
    }
}

// MARK: - Hero

/// Full-width cover image (via `AssetURLResolver`) with a bottom scrim and
/// optional overlaid title/subtitle. While loading or offline the gradient +
/// SF Symbol fallback shows.
struct HeroBlockView: View {
    let url: String
    let title: String?
    let subtitle: String?

    private var hasOverlay: Bool { title != nil || subtitle != nil }

    var body: some View {
        Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: 240)
            .overlay {
                if let imageURL = AssetURLResolver.resolve(url) {
                    AsyncImage(url: imageURL) { phase in
                        switch phase {
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        default:
                            LinkMediaFallbackView(systemIcon: "photo")
                        }
                    }
                } else {
                    LinkMediaFallbackView(systemIcon: "photo")
                }
            }
            .overlay(alignment: .bottomLeading) {
                if hasOverlay {
                    LinearGradient(colors: [.clear, .black.opacity(0.7)],
                                   startPoint: .top, endPoint: .bottom)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if hasOverlay {
                    VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
                        if let title {
                            Text(title)
                                .font(.system(size: 22, weight: .bold))
                                .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                                .foregroundStyle(.white)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let subtitle {
                            Text(subtitle)
                                .font(OpenSourcebookTheme.Fonts.caption)
                                .foregroundStyle(.white.opacity(0.85))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(OpenSourcebookTheme.Spacing.lg)
                }
            }
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r20, style: .continuous))
    }
}

// MARK: - Audio clip

/// Timed segment of a longer recording: play/pause, a scrubber clamped to
/// [start, end], and position/end times. Playback pauses at `endSeconds`;
/// pressing play from the end restarts the segment at `startSeconds`.
struct AudioClipBlockView: View {
    let url: String
    let startSeconds: Int?
    let endSeconds: Int?
    let title: String?

    @State private var player: AVPlayer? = nil
    @State private var isPlaying = false
    @State private var isBuffering = false
    @State private var position: Double = 0
    @State private var duration: Double = 0
    @State private var failed = false
    @State private var didPositionPlayer = false

    private let ticker = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()

    /// Segment bounds: [start ?? 0, end ?? stream duration], never empty.
    private var start: Double { Double(max(0, startSeconds ?? 0)) }
    private var end: Double {
        let upper = endSeconds.map { Double(max(0, $0)) } ?? duration
        return max(upper, start + 1)
    }

    /// The end time is only trustworthy once `endSeconds` is set or the
    /// stream duration is known; until then the segment-end stop stays off.
    private var hasKnownEnd: Bool { endSeconds != nil || duration > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            if let title {
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

                    Text(title)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .lineLimit(2)

                    Spacer(minLength: OpenSourcebookTheme.Spacing.xs)

                    if let segmentBadge {
                        Text(segmentBadge)
                            .font(.system(size: 11, weight: .medium))
                            .monospacedDigit()
                            .foregroundStyle(.white)
                            .padding(.horizontal, OpenSourcebookTheme.Spacing.xs)
                            .padding(.vertical, OpenSourcebookTheme.Spacing.xxs)
                            .background(.black.opacity(0.6))
                            .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r8, style: .continuous))
                    }
                }
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
                        Slider(value: $position, in: start...end) { editing in
                            if !editing {
                                seek(to: position)
                            }
                        }
                        .tint(OpenSourcebookTheme.Colors.primary)

                        HStack {
                            Text(format(position))
                            Spacer()
                            Text(hasKnownEnd ? format(end) : "--:--")
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
        guard let streamURL = AssetURLResolver.resolve(url) else {
            failed = true
            return
        }
        let newPlayer = AVPlayer(url: streamURL)
        newPlayer.automaticallyWaitsToMinimizeStalling = true
        player = newPlayer
        position = start
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
            // Restart the segment when the playhead sits outside [start, end)
            // or the player has never been positioned into it.
            if !didPositionPlayer || position < start || position >= end {
                seek(to: start)
            }
            player.play()
            isPlaying = true
            isBuffering = player.currentItem?.status != .readyToPlay
        }
        OpenSourcebookHaptics.lightImpact()
    }

    private func retry() {
        guard let streamURL = AssetURLResolver.resolve(url) else { return }
        player?.pause()
        failed = false
        isPlaying = false
        isBuffering = false
        didPositionPlayer = false
        position = start
        duration = 0
        let newPlayer = AVPlayer(url: streamURL)
        newPlayer.automaticallyWaitsToMinimizeStalling = true
        player = newPlayer
        OpenSourcebookHaptics.lightImpact()
    }

    /// Moves the playhead, clamped to the segment bounds.
    private func seek(to seconds: Double) {
        let clamped = min(max(seconds, start), end)
        player?.seek(to: CMTime(seconds: clamped, preferredTimescale: 600))
        position = clamped
        didPositionPlayer = true
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
            position = min(max(current, start), end)
        }
        isBuffering = isPlaying
            && (item.status != .readyToPlay
                || player.timeControlStatus == .waitingToPlayAtSpecifiedRate)
        // Segment end: pause with the playhead parked at `end`.
        if isPlaying, hasKnownEnd, position >= end {
            player.pause()
            isPlaying = false
            isBuffering = false
            deactivateAudioSession()
        }
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

    /// "1:23 – 2:20" badge, mirroring `ClipBlockView`'s time-range chip.
    private var segmentBadge: String? {
        guard startSeconds != nil || endSeconds != nil else { return nil }
        let startText = format(Double(max(0, startSeconds ?? 0)))
        guard let endSeconds else { return startText }
        return "\(startText) – \(format(Double(max(0, endSeconds))))"
    }

    private func format(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

// MARK: - Shared

/// Gradient + SF Symbol placeholder used while an image loads or when it
/// fails, mirroring `ImageBlockView`'s fallback.
private struct LinkMediaFallbackView: View {
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

private extension EmbedPlatform {
    var displayName: String {
        switch self {
        case .tiktok: return "TikTok"
        case .instagram: return "Instagram"
        case .x: return "X"
        case .threads: return "Threads"
        case .pinterest: return "Pinterest"
        case .reddit: return "Reddit"
        case .spotify: return "Spotify"
        case .youtube: return "YouTube"
        case .web: return "Web"
        }
    }

    var systemIcon: String {
        switch self {
        case .tiktok: return "music.note"
        case .instagram: return "camera.fill"
        case .x: return "bird.fill"
        case .threads: return "at"
        case .pinterest: return "pin.fill"
        case .reddit: return "arrow.up.arrow.down"
        case .spotify: return "waveform"
        case .youtube: return "play.rectangle.fill"
        case .web: return "link"
        }
    }

    /// Home domain, used when the URL carries no host.
    var homeDomain: String {
        switch self {
        case .tiktok: return "tiktok.com"
        case .instagram: return "instagram.com"
        case .x: return "x.com"
        case .threads: return "threads.net"
        case .pinterest: return "pinterest.com"
        case .reddit: return "reddit.com"
        case .spotify: return "spotify.com"
        case .youtube: return "youtube.com"
        case .web: return "web"
        }
    }

    /// Display domain for the fallback card: the URL's host minus "www.",
    /// falling back to the platform's home domain.
    func domain(of rawURL: String) -> String {
        guard let host = URL(string: rawURL)?.host?.lowercased(), !host.isEmpty else { return homeDomain }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}
