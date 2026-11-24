import Foundation

/// What a cited spot is (DECISIONS.md #39). Open: a value this build does
/// not know is treated as a passage (`engine/docs/byte.md`, "Cite") and keeps
/// its raw value.
struct CiteSpot: RawRepresentable, Codable, Sendable, Hashable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let passage = CiteSpot(rawValue: "passage")
    static let paragraph = CiteSpot(rawValue: "paragraph")
    static let image = CiteSpot(rawValue: "image")
    static let graph = CiteSpot(rawValue: "graph")
    static let table = CiteSpot(rawValue: "table")
    static let cell = CiteSpot(rawValue: "cell")
    static let moment = CiteSpot(rawValue: "moment")

    static let known: [CiteSpot] = [.passage, .paragraph, .image, .graph, .table, .cell, .moment]

    /// The spot as the phone draws it: itself when known, else a passage.
    var drawnAs: CiteSpot { Self.known.contains(self) ? self : .passage }

    /// True for a spot that is a picture to show.
    var isPicture: Bool { drawnAs == .image || drawnAs == .graph }

    var label: String {
        switch drawnAs {
        case .paragraph: "Paragraph"
        case .image: "Image"
        case .graph: "Graph"
        case .table: "Table"
        case .cell: "Cell"
        case .moment: "Moment"
        default: "Passage"
        }
    }

    var icon: String {
        switch drawnAs {
        case .image: "photo"
        case .graph: "chart.xyaxis.line"
        case .table, .cell: "tablecells"
        case .moment: "waveform"
        default: "text.quote"
        }
    }
}

/// Where a bit's or a question's content came from: one spot in one source
/// (`Cite` in `engine/docs/byte.md`).
struct Cite: Codable, Sendable, Hashable {
    var sourceId: String
    var spot: CiteSpot
    var chunkId: String?
    var locator: SourceLocator?
    var assetId: String?
    var quote: String?
    /// The block of the bit it grounds; nil means the whole bit.
    var block: Int?

    init(sourceId: String, spot: CiteSpot = .passage, chunkId: String? = nil, locator: SourceLocator? = nil,
         assetId: String? = nil, quote: String? = nil, block: Int? = nil) {
        self.sourceId = sourceId
        self.spot = spot
        self.chunkId = chunkId
        self.locator = locator
        self.assetId = assetId
        self.quote = quote
        self.block = block
    }

    private enum CodingKeys: String, CodingKey { case sourceId, spot, chunkId, locator, assetId, quote, block }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sourceId = try c.decode(String.self, forKey: .sourceId)
        spot = (try? c.decodeIfPresent(CiteSpot.self, forKey: .spot)) ?? .passage
        chunkId = try? c.decodeIfPresent(String.self, forKey: .chunkId)
        locator = try? c.decodeIfPresent(SourceLocator.self, forKey: .locator)
        assetId = try? c.decodeIfPresent(String.self, forKey: .assetId)
        let text = (try? c.decodeIfPresent(String.self, forKey: .quote))?.trimmingCharacters(in: .whitespacesAndNewlines)
        quote = text?.isEmpty == false ? text : nil
        block = try? c.decodeIfPresent(Int.self, forKey: .block)
    }

    /// The cites in a payload's raw list; entries that are not cites are dropped.
    static func list(_ raw: [JSONValue]) -> [Cite] {
        raw.compactMap { value in
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return try? JSONDecoder().decode(Cite.self, from: data)
        }
    }

    /// Where in the source, in words: "page 4", "pages 3–9", "slide 2",
    /// "0:42–1:05", "cell B4". Nil when the locator says nothing a person
    /// can use (a bare character range).
    var place: String? {
        guard let at = locator else { return nil }
        var parts: [String] = []
        if let page = at.page {
            parts.append(at.endPage.map { $0 > page ? "pages \(page)–\($0)" : "page \(page)" } ?? "page \(page)")
        }
        if let slide = at.slide {
            parts.append(at.endSlide.map { $0 > slide ? "slides \(slide)–\($0)" : "slide \(slide)" } ?? "slide \(slide)")
        }
        if let start = at.startMs {
            let from = Self.clock(start)
            parts.append(at.endMs.map { $0 > start ? "\(from)–\(Self.clock($0))" : from } ?? from)
        }
        if let cell = at.cell { parts.append("cell \(cell)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// m:ss, or h:mm:ss past an hour.
    static func clock(_ ms: Int) -> String {
        let seconds = max(0, ms) / 1000
        let (h, m, s) = (seconds / 3600, (seconds % 3600) / 60, seconds % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}

/// The cites of one source on one screen: what a chip under a bit stands for.
struct CiteGroup: Identifiable, Sendable, Hashable {
    let sourceId: String
    /// In the order the payload lists them, repeats removed.
    let cites: [Cite]

    var id: String { sourceId }

    /// The cites of a bit or question grouped by source, sources in the order
    /// they are first cited.
    static func groups(_ raw: [JSONValue]) -> [CiteGroup] {
        var order: [String] = []
        var bySource: [String: [Cite]] = [:]
        for cite in Cite.list(raw) {
            if bySource[cite.sourceId] == nil { order.append(cite.sourceId) }
            var list = bySource[cite.sourceId, default: []]
            // The same spot and quote cited for two blocks shows once.
            if !list.contains(where: { $0.spot == cite.spot && $0.locator == cite.locator && $0.quote == cite.quote && $0.assetId == cite.assetId }) {
                list.append(cite)
            }
            bySource[cite.sourceId] = list
        }
        return order.map { CiteGroup(sourceId: $0, cites: bySource[$0] ?? []) }
    }

    /// The chip's words: the source's name and, when every cite is on one
    /// page or moment, where. Without a name, "Source n" by position.
    func chipLabel(sourceName: String?, position: Int) -> String {
        let name = sourceName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = (name?.isEmpty == false ? name! : "Source \(position + 1)")
        let places = Set(cites.compactMap(\.place))
        if places.count == 1, let place = places.first, cites.allSatisfy({ $0.place != nil }) {
            return "\(base) · \(place)"
        }
        return base
    }
}

/// A cited passage shown in its place: some text before, the marked words,
/// some text after. Character offsets in a locator are the engine's string
/// offsets (UTF-16 code units).
struct CiteExcerpt: Equatable, Sendable {
    var before: String
    var marked: String
    var after: String

    /// The quote inside the cited span when it is there (any case), else the
    /// span; without a span, the quote anywhere in the text. Nil when neither
    /// can be found. `radius` is how many characters to keep on each side.
    static func make(text: String, cite: Cite, radius: Int = 240) -> CiteExcerpt? {
        let length = text.utf16.count
        var span: Range<String.Index>?
        if let start = cite.locator?.charStart ?? (cite.locator?.charEnd != nil ? 0 : nil) {
            let end = min(length, cite.locator?.charEnd ?? length)
            let lower = min(max(0, start), length)
            if end > lower {
                // Widened to whole characters, so an offset inside an emoji never splits it.
                let whole = (text as NSString).rangeOfComposedCharacterSequences(for: NSRange(location: lower, length: end - lower))
                span = Range(whole, in: text)
            }
        }
        var mark: Range<String.Index>?
        if let quote = cite.quote {
            mark = text.range(of: quote, options: [.caseInsensitive, .diacriticInsensitive], range: span)
                ?? (span == nil ? nil : text.range(of: quote, options: [.caseInsensitive, .diacriticInsensitive]))
        }
        guard let marked = mark ?? span, !marked.isEmpty else { return nil }

        let lead = text[..<marked.lowerBound]
        let tail = text[marked.upperBound...]
        var before = String(lead.suffix(radius))
        var after = String(tail.prefix(radius))
        if before.count < lead.count {
            if let space = before.firstIndex(where: \.isWhitespace) { before = String(before[space...]) }
            before = "…" + before.trimmingCharacters(in: .whitespaces)
        }
        if after.count < tail.count {
            if let space = after.lastIndex(where: \.isWhitespace) { after = String(after[..<space]) }
            after += "…"
        }
        return CiteExcerpt(before: before, marked: String(text[marked]), after: after)
    }
}
