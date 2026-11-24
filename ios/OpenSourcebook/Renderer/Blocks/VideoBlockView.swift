import SwiftUI
#if canImport(UIKit)
import WebKit
#endif

/// Tap-to-load YouTube embed (16:9). Shows a thumbnail facade with a play
/// button until tapped; the WKWebView only loads on demand.
struct VideoBlockView: View {
    let youtubeID: String
    let title: String?

    @State private var isLoaded = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            ZStack {
                if isLoaded {
                    loadedContent
                } else {
                    facade
                }
            }
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

    // MARK: Facade

    private var facade: some View {
        Button {
            #if canImport(UIKit)
            withAnimation(OpenSourcebookTheme.Motion.standard) { isLoaded = true }
            #else
            if let url = URL(string: "https://www.youtube.com/watch?v=\(youtubeID)") { openURL(url) }
            #endif
            OpenSourcebookHaptics.lightImpact()
        } label: {
            ZStack {
                AsyncImage(url: URL(string: "https://i.ytimg.com/vi/\(youtubeID)/hqdefault.jpg")) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().aspectRatio(contentMode: .fill)
                    default:
                        LinearGradient(colors: [Color(hex: 0x1E293B), Color(hex: 0x0F172A)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    }
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
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Play video")
    }

    // MARK: Loaded content

    @ViewBuilder
    private var loadedContent: some View {
        #if canImport(UIKit)
        YouTubeEmbedView(youtubeID: youtubeID)
        #else
        Color.black.overlay {
            Text("Open on an iOS device to play inline")
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(.white.opacity(0.7))
        }
        #endif
    }
}

#if canImport(UIKit)
private struct YouTubeEmbedView: UIViewRepresentable {
    let youtubeID: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        // Let the tapped facade's intent start playback without a second gesture.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.scrollView.isScrollEnabled = false
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.navigationDelegate = context.coordinator
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // Load once per ID — updateUIView fires on unrelated state changes.
        guard context.coordinator.loadedID != youtubeID else { return }
        context.coordinator.loadedID = youtubeID
        // Embedder identity: YouTube rejects embeds whose referrer/origin is
        // youtube.com itself (error 152-4) and embeds with no referrer at all
        // (error 153). The documented identity is the app's bundle ID.
        let bundleID = (Bundle.main.bundleIdentifier ?? "app.opensourcebook").lowercased()
        let origin = "https://\(bundleID)"
        webView.loadHTMLString(Self.embedHTML(for: youtubeID, origin: origin),
                               baseURL: URL(string: "\(origin)/"))
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedID: String?
    }

    private static func embedHTML(for id: String, origin: String) -> String {
        let encodedOrigin = origin.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? origin
        return """
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
        <iframe src="https://www.youtube-nocookie.com/embed/\(id)?playsinline=1&rel=0&autoplay=1&origin=\(encodedOrigin)"
                referrerpolicy="strict-origin-when-cross-origin"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowfullscreen></iframe>
        </body>
        </html>
        """
    }
}
#endif
