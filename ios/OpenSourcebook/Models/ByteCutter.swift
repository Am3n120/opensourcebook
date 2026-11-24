import Foundation

/// Cuts an old stored page (one long list of blocks, formats `read` and
/// `bits`, schema version 1) into bits, so it opens as a byte like anything
/// made today. Follows the upgrade in `engine/docs/byte.md` ("Old outputs"),
/// so a page cut here and one the engine serves upgraded agree:
///
/// - a new bit starts at each `heading` or `kicker` (a heading right after a
///   kicker stays with it), and whenever the next block would push the bit
///   over the budget;
/// - a text block longer than a bit is split at paragraph, then sentence,
///   ends;
/// - `toc`, `continuation`, `spacer` and `divider` are page layout and are
///   dropped; `hero` becomes `figure`; `audio` becomes `linkCard`; a
///   `flashcards` block becomes one `flip` bit per card.
///
/// Nothing else is dropped: every other block lands in exactly one bit, in
/// order. A pure function of the blocks, so the same page always gives the
/// same bits.
enum ByteCutter {
    /// What one bit may cost, in the contract's units.
    static let budget = 900

    static func bits(from blocks: [Block]) -> [Bit] {
        var screens: [(kind: String, blocks: [Block])] = []
        var current: [Block] = []
        var spent = 0

        func close() {
            if !current.isEmpty { screens.append(("plain", current)) }
            current = []
            spent = 0
        }

        func add(_ block: Block) {
            let cost = Self.cost(of: block)
            let onlyLabels = current.allSatisfy(\.isLabel)
            if !current.isEmpty, !onlyLabels, spent + cost > budget { close() }
            current.append(block)
            spent += cost
        }

        for block in blocks {
            switch block {
            case .toc, .continuation, .spacer, .divider:
                continue
            case .flashcards(let cards) where cards.count > 1:
                close()
                for card in cards { screens.append(("flip", [.flashcards(cards: [card])])) }
                continue
            case .flashcards:
                close()
                screens.append(("flip", [block]))
                continue
            default:
                break
            }
            let block = upgraded(block)
            if block.startsBit, !current.isEmpty, !(block.isHeading && current.allSatisfy(\.isKicker)) {
                close()
            }
            if case .text(let text) = block, cost(of: block) > budget {
                for piece in split(text) { add(.text(piece)) }
            } else {
                add(block)
            }
        }
        close()

        return screens.enumerated().map { index, screen in
            Bit(id: "b\(index + 1)", kind: screen.kind, blocks: screen.blocks)
        }
    }

    // MARK: - Block changes

    private static func upgraded(_ block: Block) -> Block {
        switch block {
        case .hero(let url, let title, let subtitle):
            let caption = [title, subtitle].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            return .figure(url: url, caption: caption.isEmpty ? nil : caption, credit: nil, systemIcon: nil)
        case .audio(let url, let title, let subtitle):
            let domain = URL(string: url)?.host() ?? subtitle ?? ""
            return .linkCard(url: url, title: title, domain: domain)
        default:
            return block
        }
    }

    // MARK: - Splitting long text

    /// `text` in pieces that each fit a bit: whole paragraphs where they fit,
    /// then whole sentences, then words. Joined back, the pieces give the
    /// same words in the same order.
    static func split(_ text: String) -> [String] {
        let paragraphs = text.components(separatedBy: "\n\n").filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let units = paragraphs.flatMap { paragraph -> [(String, String)] in
            if textCost(paragraph) <= budget { return [(paragraph, "\n\n")] }
            return sentences(in: paragraph).flatMap { sentence -> [(String, String)] in
                if textCost(sentence) <= budget { return [(sentence, " ")] }
                return words(sentence).map { ($0, " ") }
            }
        }
        var pieces: [String] = []
        var piece = ""
        var separator = ""
        for (unit, joiner) in units {
            let candidate = piece.isEmpty ? unit : piece + separator + unit
            if !piece.isEmpty, textCost(candidate) > budget {
                pieces.append(piece)
                piece = unit
            } else {
                piece = candidate
            }
            separator = joiner
        }
        if !piece.isEmpty { pieces.append(piece) }
        return pieces
    }

    private static func textCost(_ text: String) -> Int { max(40, text.count) }

    private static func sentences(in paragraph: String) -> [String] {
        var result: [String] = []
        paragraph.enumerateSubstrings(in: paragraph.startIndex..., options: .bySentences) { sentence, _, _, _ in
            if let sentence = sentence?.trimmingCharacters(in: .whitespacesAndNewlines), !sentence.isEmpty {
                result.append(sentence)
            }
        }
        return result.isEmpty ? [paragraph] : result
    }

    /// A sentence longer than a bit, in runs of whole words that fit.
    private static func words(_ sentence: String) -> [String] {
        var runs: [String] = []
        var run = ""
        for word in sentence.split(whereSeparator: \.isWhitespace) {
            let candidate = run.isEmpty ? String(word) : run + " " + word
            if !run.isEmpty, candidate.count > budget {
                runs.append(run)
                run = String(word)
            } else {
                run = candidate
            }
        }
        if !run.isEmpty { runs.append(run) }
        return runs
    }

    // MARK: - Cost

    /// `max(40, text) + lines + area`, as `engine/docs/byte.md` defines it.
    static func cost(of block: Block) -> Int {
        let json = (try? JSONEncoder().encode(block)).flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? .null
        let type = json["type"]?.stringValue ?? ""
        return max(40, shownCharacters(in: json)) + lines(type: type, json: json) + area(type: type)
    }

    /// Keys whose strings are not shown as words.
    private static let unshownKeys: Set<String> = [
        "type", "url", "imageURL", "posterURL", "youtubeID", "systemIcon", "style",
        "platform", "language", "color", "id", "html", "columns",
    ]

    private static func shownCharacters(in value: JSONValue, key: String? = nil) -> Int {
        switch value {
        case .string(let text):
            if let key, unshownKeys.contains(key) { return 0 }
            return text.count
        case .array(let items):
            return items.reduce(0) { $0 + shownCharacters(in: $1, key: key) }
        case .object(let fields):
            return fields.reduce(0) { $0 + shownCharacters(in: $1.value, key: $1.key) }
        default:
            return 0
        }
    }

    private static func lines(type: String, json: JSONValue) -> Int {
        func count(_ key: String) -> Int {
            if case .array(let items)? = json[key] { return items.count }
            return 0
        }
        let parts: Int
        switch type {
        case "bullets", "numbered", "checklist", "timeline", "orderExercise": parts = count("items")
        case "table": parts = count("rows") + 1
        case "code": parts = (json["text"]?.stringValue ?? "").split(separator: "\n", omittingEmptySubsequences: false).count
        case "quiz", "fillInBlank": parts = count("options")
        case "matching": parts = count("pairs")
        case "servingsScaler": parts = count("ingredients")
        case "metrics": parts = count("stats")
        case "prosCons": parts = count("pros") + count("cons")
        default: parts = 1
        }
        return max(0, parts - 1) * 40
    }

    private static let halfScreen: Set<String> = [
        "image", "figure", "gallery", "carousel", "clip", "video", "embed", "map",
        "lineChart", "barChart", "areaChart", "stackedBar", "pie", "scatter",
        "heatmap", "histogram", "radar", "gauge",
    ]

    private static func area(type: String) -> Int {
        if halfScreen.contains(type) { return 350 }
        if ["metrics", "linkPreview", "bigStat"].contains(type) { return 120 }
        return 0
    }
}

private extension Block {
    var isHeading: Bool { if case .heading = self { true } else { false } }
    var isKicker: Bool { if case .kicker = self { true } else { false } }
    var startsBit: Bool { isHeading || isKicker }
    /// Section labels: a bit of only these never closes before its content.
    var isLabel: Bool {
        switch self {
        case .kicker, .heading, .subheading: true
        default: false
        }
    }
}
