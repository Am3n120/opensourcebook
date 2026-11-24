import SwiftUI

/// A single content unit of a bit (DECISIONS.md #34).
///
/// A bit is a few blocks drawn top to bottom on one screen (`BitView`); an
/// old stored page is one long list of them, cut into bits by `ByteCutter`.
/// Interactive blocks (checklist, quiz, servingsScaler,
/// timer, orderExercise, reveal) keep their state locally in their view.
///
/// - Note: `Identifiable` is satisfied with a hash-derived id; renderers should
///   enumerate blocks (`Array(blocks.enumerated()), id: \.offset`) for stable
///   ordering, which `BitView` does.
enum Block: Identifiable, Hashable, Sendable {

    // MARK: Text & structure

    /// Small purple uppercase section cue (the "1 · START" style label).
    case kicker(String)
    /// Large section heading.
    case heading(String)
    /// Medium subheading.
    case subheading(String)
    /// Body paragraph. Supports lightweight markdown: **bold**, *italic*, `code`.
    case text(String)
    /// Large serif-styled quote card.
    case quote(text: String, author: String?, source: String?)
    /// Horizontal rule.
    case divider
    /// Subtle centered "···" continuation cue.
    case continuation
    /// Breathing room.
    case spacer

    // MARK: Media & references

    /// Remote image with gradient + SF Symbol fallback while loading/offline.
    case image(url: String?, caption: String?, systemIcon: String)
    /// Tap-to-load YouTube embed (16:9 facade until tapped).
    case video(youtubeID: String, title: String?)
    /// Streaming audio player (play/pause, times, scrubber).
    case audio(url: String, title: String, subtitle: String?)
    /// Tappable reference card; opens the URL.
    case linkCard(url: String, title: String, domain: String)

    // MARK: Asset-bound media (engine-extracted)

    /// Extracted figure/diagram with provenance. `url` may be absolute or a
    /// worker-relative `/v1/assets/<id>` path (resolved via `AssetURLResolver`).
    case figure(url: String, caption: String?, credit: String?, systemIcon: String?)
    /// Grid of extracted images with tap-to-zoom. `columns` is 2 or 3 (default 2).
    case gallery(images: [GalleryItem], columns: Int?)
    /// Timed video clip card; tap opens the source at `startSeconds`.
    case clip(url: String, startSeconds: Int, endSeconds: Int?, title: String?, posterURL: String?, platform: ClipPlatform?)

    // MARK: Data & structured content

    /// Tinted callout box.
    case callout(style: CalloutStyle, title: String?, text: String)
    /// Unordered bullet list.
    case bullets([String])
    /// Numbered list.
    case numbered([String])
    /// 2-column stat grid with delta coloring.
    case metrics([StatItem])
    /// Custom-drawn multi-series line chart (no Charts framework).
    case lineChart(title: String?, xLabels: [String], series: [LineSeries])
    /// Horizontal bar chart with animated fill.
    case barChart(title: String?, items: [BarItem])
    /// Clean table; first column left-aligned, zebra striping.
    case table(headers: [String], rows: [[String]])
    /// Vertical rail with dots.
    case timeline(items: [TimelineItem])
    /// Dark monospaced code card with language label.
    case code(String, language: String)
    /// Hero number.
    case bigStat(value: String, label: String, delta: String?)

    // MARK: Interactive

    /// Tappable circles with checkmark + strikethrough; state is local to the view.
    case checklist(items: [String])
    /// Tap an option: correct → green, wrong → red + correct shown; explanation appears.
    case quiz(question: String, options: [String], correctIndex: Int, explanation: String?)
    /// Servings stepper re-scaling ingredient quantities live.
    case servingsScaler(baseServings: Int, ingredients: [ScaledIngredient])
    /// Working countdown timer (start/pause/reset, mm:ss).
    case timer(label: String, seconds: Int)
    /// Expandable section for optional/deeper content.
    indirect case reveal(title: String, blocks: [Block])
    /// Drag-to-reorder exercise; checked against `correctOrder` (indices into the
    /// ORIGINAL `items` array, in the correct sequence).
    case orderExercise(prompt: String, items: [String], correctOrder: [Int])

    // MARK: Extended charts

    /// Color-intensity grid; `values` is rows (yLabels) × columns (xLabels).
    case heatmap(title: String?, xLabels: [String], yLabels: [String], values: [[Double]], minLabel: String?, maxLabel: String?)
    /// X/Y dot plot with optional per-point labels.
    case scatter(title: String?, xLabel: String?, yLabel: String?, points: [ScatterPoint])
    /// Proportion slices; `displayValue` is the preformatted slice label.
    case pie(title: String?, items: [PieItem])
    /// Filled line chart (single or multi-series).
    case areaChart(title: String?, xLabels: [String], series: [LineSeries])
    /// Bars segmented by series, stacked per category.
    case stackedBar(title: String?, categories: [String], series: [StackedBarSeries])
    /// Single-value dial with supporting detail.
    case gauge(value: Double, label: String, detail: String?)
    /// Frequency distribution over labeled bins.
    case histogram(title: String?, bins: [HistogramBin])
    /// Multi-axis polygon comparison.
    case radar(title: String?, axes: [String], series: [RadarSeries])

    // MARK: Learning

    /// Flip deck of front/back cards.
    case flashcards(cards: [Flashcard])
    /// Complete-the-sentence exercise; `options` turns it into multiple choice.
    case fillInBlank(prompt: String, answer: String, options: [String]?, explanation: String?)
    /// Left/right pairing exercise.
    case matching(prompt: String?, pairs: [MatchingPair])
    /// Two-column comparison of advantages and drawbacks.
    case prosCons(pros: ProsConsColumn, cons: ProsConsColumn)
    /// Term card with optional source attribution.
    case definition(term: String, definition: String, source: String?)

    // MARK: Link & media

    /// Third-party embed card. Named platforms use their official embed URL;
    /// `.web` carries optional oEmbed HTML returned by the engine.
    case embed(platform: EmbedPlatform, url: String, title: String?, html: String?)
    /// Rich link card with description and optional thumbnail.
    case linkPreview(url: String, title: String, domain: String, description: String?, imageURL: String?)
    /// Horizontally swipeable strip of images.
    case carousel(items: [CarouselItem])
    /// Map card with named pins.
    case map(title: String?, places: [MapPlace])
    /// Full-width banner image with overlaid title/subtitle.
    case hero(url: String, title: String?, subtitle: String?)
    /// Timed audio segment of a longer recording.
    case audioClip(url: String, startSeconds: Int?, endSeconds: Int?, title: String?)

    // MARK: Document structure

    /// Table-of-contents card listing the output's sections.
    case toc(title: String?, items: [String])
    /// Rendered LaTeX formula with optional caption.
    case math(latex: String, caption: String?)

    // MARK: Forward compatibility

    /// A block type this build does not know. The raw JSON is kept so the
    /// output survives a round trip and a newer app can render it; the view
    /// shows a quiet placeholder instead of dropping the whole output.
    case unsupported(type: String, payload: JSONValue)

    // `Identifiable` — renderers should prefer enumerated offsets for stability.
    var id: Int { hashValue }
}

// MARK: - Supporting types

/// Tint variants for `.callout`.
enum CalloutStyle: String, CaseIterable, Hashable, Sendable {
    case info, success, warning, primary

    var color: Color {
        switch self {
        case .info: return OpenSourcebookTheme.Colors.info
        case .success: return OpenSourcebookTheme.Colors.success
        case .warning: return OpenSourcebookTheme.Colors.accent
        case .primary: return OpenSourcebookTheme.Colors.primary
        }
    }

    var softColor: Color {
        switch self {
        case .info: return OpenSourcebookTheme.Colors.infoSoft
        case .success: return OpenSourcebookTheme.Colors.successSoft
        case .warning: return OpenSourcebookTheme.Colors.accentSoft
        case .primary: return OpenSourcebookTheme.Colors.primarySoft
        }
    }

    var icon: String {
        switch self {
        case .info: return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .primary: return "sparkles"
        }
    }
}

/// One series of a `.lineChart`.
struct LineSeries: Hashable, Sendable {
    var name: String
    var values: [Double]
    var color: SeriesColor

    init(name: String, values: [Double], color: SeriesColor) {
        self.name = name
        self.values = values
        self.color = color
    }
}

/// Palette for chart series, mapped to OpenSourcebookTheme colors.
enum SeriesColor: String, CaseIterable, Hashable, Sendable {
    case primary, info, success, accent

    var color: Color {
        switch self {
        case .primary: return OpenSourcebookTheme.Colors.primary
        case .info: return OpenSourcebookTheme.Colors.info
        case .success: return OpenSourcebookTheme.Colors.success
        case .accent: return OpenSourcebookTheme.Colors.accent
        }
    }
}

/// One row of a `.barChart`.
struct BarItem: Hashable, Sendable {
    var label: String
    var value: Double
    var displayValue: String

    init(label: String, value: Double, displayValue: String) {
        self.label = label
        self.value = value
        self.displayValue = displayValue
    }
}

/// One stop of a `.timeline`.
struct TimelineItem: Hashable, Sendable {
    var label: String
    var title: String
    var detail: String?

    init(label: String, title: String, detail: String? = nil) {
        self.label = label
        self.title = title
        self.detail = detail
    }
}

/// One ingredient of a `.servingsScaler`. `quantity == nil` renders "to taste".
struct ScaledIngredient: Hashable, Sendable {
    var quantity: Double?
    var unit: String
    var name: String

    init(quantity: Double?, unit: String, name: String) {
        self.quantity = quantity
        self.unit = unit
        self.name = name
    }
}

/// One image of a `.gallery`.
struct GalleryItem: Hashable, Sendable {
    var url: String
    var caption: String?

    init(url: String, caption: String? = nil) {
        self.url = url
        self.caption = caption
    }
}

/// Source platform of a `.clip`.
enum ClipPlatform: String, CaseIterable, Hashable, Sendable {
    case youtube, tiktok, instagram, vimeo, web
}

/// One point of a `.scatter`.
struct ScatterPoint: Hashable, Sendable {
    var x: Double
    var y: Double
    var label: String?

    init(x: Double, y: Double, label: String? = nil) {
        self.x = x
        self.y = y
        self.label = label
    }
}

/// One slice of a `.pie`. `displayValue` is the preformatted label (e.g. "42%").
struct PieItem: Hashable, Sendable {
    var label: String
    var value: Double
    var displayValue: String?

    init(label: String, value: Double, displayValue: String? = nil) {
        self.label = label
        self.value = value
        self.displayValue = displayValue
    }
}

/// One series of a `.stackedBar`; `values` aligns with the block's `categories`.
struct StackedBarSeries: Hashable, Sendable {
    var name: String
    var values: [Double]
    var color: SeriesColor

    init(name: String, values: [Double], color: SeriesColor) {
        self.name = name
        self.values = values
        self.color = color
    }
}

/// One bin of a `.histogram`.
struct HistogramBin: Hashable, Sendable {
    var label: String
    var count: Double

    init(label: String, count: Double) {
        self.label = label
        self.count = count
    }
}

/// One series of a `.radar`; `values` aligns with the block's `axes`.
struct RadarSeries: Hashable, Sendable {
    var name: String
    var values: [Double]
    var color: SeriesColor

    init(name: String, values: [Double], color: SeriesColor) {
        self.name = name
        self.values = values
        self.color = color
    }
}

/// One card of a `.flashcards` deck.
struct Flashcard: Hashable, Sendable {
    var front: String
    var back: String

    init(front: String, back: String) {
        self.front = front
        self.back = back
    }
}

/// One pair of a `.matching` exercise.
struct MatchingPair: Hashable, Sendable {
    var left: String
    var right: String

    init(left: String, right: String) {
        self.left = left
        self.right = right
    }
}

/// One column of a `.prosCons`.
struct ProsConsColumn: Hashable, Sendable {
    var title: String?
    var items: [String]

    init(title: String? = nil, items: [String]) {
        self.title = title
        self.items = items
    }
}

/// Source platform of an `.embed`. `web` is the generic oEmbed tier.
enum EmbedPlatform: String, CaseIterable, Hashable, Sendable {
    case tiktok, instagram, x, threads, pinterest, reddit, spotify, youtube, web
}

/// One image of a `.carousel`.
struct CarouselItem: Hashable, Sendable {
    var url: String
    var caption: String?

    init(url: String, caption: String? = nil) {
        self.url = url
        self.caption = caption
    }
}

/// One pin of a `.map`.
struct MapPlace: Hashable, Sendable {
    var name: String
    var latitude: Double
    var longitude: Double
    var note: String?

    init(name: String, latitude: Double, longitude: Double, note: String? = nil) {
        self.name = name
        self.latitude = latitude
        self.longitude = longitude
        self.note = note
    }
}

// MARK: - Codable

extension CalloutStyle: Codable {}
extension LineSeries: Codable {}
extension SeriesColor: Codable {}
extension BarItem: Codable {}
extension TimelineItem: Codable {}
extension ScaledIngredient: Codable {}
extension GalleryItem: Codable {}
extension ClipPlatform: Codable {}
extension ScatterPoint: Codable {}
extension PieItem: Codable {}
extension StackedBarSeries: Codable {}
extension HistogramBin: Codable {}
extension RadarSeries: Codable {}
extension Flashcard: Codable {}
extension MatchingPair: Codable {}
extension ProsConsColumn: Codable {}
extension EmbedPlatform: Codable {}
extension CarouselItem: Codable {}
extension MapPlace: Codable {}

extension Block: Codable {
    private enum CodingKeys: String, CodingKey {
        case type
        case text
        case author
        case source
        case url
        case caption
        case systemIcon
        case youtubeID
        case title
        case subtitle
        case domain
        case credit
        case images
        case columns
        case startSeconds
        case endSeconds
        case posterURL
        case platform
        case style
        case items
        case stats
        case xLabels
        case series
        case headers
        case rows
        case language
        case value
        case label
        case delta
        case question
        case options
        case correctIndex
        case explanation
        case baseServings
        case ingredients
        case seconds
        case blocks
        case prompt
        case correctOrder
        case yLabels
        case values
        case minLabel
        case maxLabel
        case xLabel
        case yLabel
        case points
        case categories
        case detail
        case bins
        case axes
        case cards
        case answer
        case pairs
        case pros
        case cons
        case term
        case definition
        case description
        case imageURL
        case places
        case latex
        case html
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "kicker":
            self = .kicker(try container.decode(String.self, forKey: .text))
        case "heading":
            self = .heading(try container.decode(String.self, forKey: .text))
        case "subheading":
            self = .subheading(try container.decode(String.self, forKey: .text))
        case "text":
            self = .text(try container.decode(String.self, forKey: .text))
        case "quote":
            self = .quote(
                text: try container.decode(String.self, forKey: .text),
                author: try container.decodeIfPresent(String.self, forKey: .author),
                source: try container.decodeIfPresent(String.self, forKey: .source)
            )
        case "divider":
            self = .divider
        case "continuation":
            self = .continuation
        case "spacer":
            self = .spacer
        case "image":
            self = .image(
                url: try container.decodeIfPresent(String.self, forKey: .url),
                caption: try container.decodeIfPresent(String.self, forKey: .caption),
                systemIcon: try container.decode(String.self, forKey: .systemIcon)
            )
        case "video":
            self = .video(
                youtubeID: try container.decode(String.self, forKey: .youtubeID),
                title: try container.decodeIfPresent(String.self, forKey: .title)
            )
        case "audio":
            self = .audio(
                url: try container.decode(String.self, forKey: .url),
                title: try container.decode(String.self, forKey: .title),
                subtitle: try container.decodeIfPresent(String.self, forKey: .subtitle)
            )
        case "linkCard":
            self = .linkCard(
                url: try container.decode(String.self, forKey: .url),
                title: try container.decode(String.self, forKey: .title),
                domain: try container.decode(String.self, forKey: .domain)
            )
        case "figure":
            self = .figure(
                url: try container.decode(String.self, forKey: .url),
                caption: try container.decodeIfPresent(String.self, forKey: .caption),
                credit: try container.decodeIfPresent(String.self, forKey: .credit),
                systemIcon: try container.decodeIfPresent(String.self, forKey: .systemIcon)
            )
        case "gallery":
            self = .gallery(
                images: try container.decode([GalleryItem].self, forKey: .images),
                columns: try container.decodeIfPresent(Int.self, forKey: .columns)
            )
        case "clip":
            self = .clip(
                url: try container.decode(String.self, forKey: .url),
                startSeconds: try container.decode(Int.self, forKey: .startSeconds),
                endSeconds: try container.decodeIfPresent(Int.self, forKey: .endSeconds),
                title: try container.decodeIfPresent(String.self, forKey: .title),
                posterURL: try container.decodeIfPresent(String.self, forKey: .posterURL),
                // Unknown platforms decode to nil so newer engine platforms
                // degrade to a generic web clip instead of failing the block.
                platform: (try? container.decodeIfPresent(ClipPlatform.self, forKey: .platform)) ?? nil
            )
        case "callout":
            self = .callout(
                style: try container.decode(CalloutStyle.self, forKey: .style),
                title: try container.decodeIfPresent(String.self, forKey: .title),
                text: try container.decode(String.self, forKey: .text)
            )
        case "bullets":
            self = .bullets(try container.decode([String].self, forKey: .items))
        case "numbered":
            self = .numbered(try container.decode([String].self, forKey: .items))
        case "metrics":
            self = .metrics(try container.decode([StatItem].self, forKey: .stats))
        case "lineChart":
            self = .lineChart(
                title: try container.decodeIfPresent(String.self, forKey: .title),
                xLabels: try container.decode([String].self, forKey: .xLabels),
                series: try container.decode([LineSeries].self, forKey: .series)
            )
        case "barChart":
            self = .barChart(
                title: try container.decodeIfPresent(String.self, forKey: .title),
                items: try container.decode([BarItem].self, forKey: .items)
            )
        case "table":
            self = .table(
                headers: try container.decode([String].self, forKey: .headers),
                rows: try container.decode([[String]].self, forKey: .rows)
            )
        case "timeline":
            self = .timeline(items: try container.decode([TimelineItem].self, forKey: .items))
        case "code":
            self = .code(
                try container.decode(String.self, forKey: .text),
                language: try container.decode(String.self, forKey: .language)
            )
        case "bigStat":
            self = .bigStat(
                value: try container.decode(String.self, forKey: .value),
                label: try container.decode(String.self, forKey: .label),
                delta: try container.decodeIfPresent(String.self, forKey: .delta)
            )
        case "checklist":
            self = .checklist(items: try container.decode([String].self, forKey: .items))
        case "quiz":
            self = .quiz(
                question: try container.decode(String.self, forKey: .question),
                options: try container.decode([String].self, forKey: .options),
                correctIndex: try container.decode(Int.self, forKey: .correctIndex),
                explanation: try container.decodeIfPresent(String.self, forKey: .explanation)
            )
        case "servingsScaler":
            self = .servingsScaler(
                baseServings: try container.decode(Int.self, forKey: .baseServings),
                ingredients: try container.decode([ScaledIngredient].self, forKey: .ingredients)
            )
        case "timer":
            self = .timer(
                label: try container.decode(String.self, forKey: .label),
                seconds: try container.decode(Int.self, forKey: .seconds)
            )
        case "reveal":
            self = .reveal(
                title: try container.decode(String.self, forKey: .title),
                blocks: try container.decode([Block].self, forKey: .blocks)
            )
        case "orderExercise":
            self = .orderExercise(
                prompt: try container.decode(String.self, forKey: .prompt),
                items: try container.decode([String].self, forKey: .items),
                correctOrder: try container.decode([Int].self, forKey: .correctOrder)
            )
        case "heatmap":
            self = .heatmap(
                title: try container.decodeIfPresent(String.self, forKey: .title),
                xLabels: try container.decode([String].self, forKey: .xLabels),
                yLabels: try container.decode([String].self, forKey: .yLabels),
                values: try container.decode([[Double]].self, forKey: .values),
                minLabel: try container.decodeIfPresent(String.self, forKey: .minLabel),
                maxLabel: try container.decodeIfPresent(String.self, forKey: .maxLabel)
            )
        case "scatter":
            self = .scatter(
                title: try container.decodeIfPresent(String.self, forKey: .title),
                xLabel: try container.decodeIfPresent(String.self, forKey: .xLabel),
                yLabel: try container.decodeIfPresent(String.self, forKey: .yLabel),
                points: try container.decode([ScatterPoint].self, forKey: .points)
            )
        case "pie":
            self = .pie(
                title: try container.decodeIfPresent(String.self, forKey: .title),
                items: try container.decode([PieItem].self, forKey: .items)
            )
        case "areaChart":
            self = .areaChart(
                title: try container.decodeIfPresent(String.self, forKey: .title),
                xLabels: try container.decode([String].self, forKey: .xLabels),
                series: try container.decode([LineSeries].self, forKey: .series)
            )
        case "stackedBar":
            self = .stackedBar(
                title: try container.decodeIfPresent(String.self, forKey: .title),
                categories: try container.decode([String].self, forKey: .categories),
                series: try container.decode([StackedBarSeries].self, forKey: .series)
            )
        case "gauge":
            self = .gauge(
                value: try container.decode(Double.self, forKey: .value),
                label: try container.decode(String.self, forKey: .label),
                detail: try container.decodeIfPresent(String.self, forKey: .detail)
            )
        case "histogram":
            self = .histogram(
                title: try container.decodeIfPresent(String.self, forKey: .title),
                bins: try container.decode([HistogramBin].self, forKey: .bins)
            )
        case "radar":
            self = .radar(
                title: try container.decodeIfPresent(String.self, forKey: .title),
                axes: try container.decode([String].self, forKey: .axes),
                series: try container.decode([RadarSeries].self, forKey: .series)
            )
        case "flashcards":
            self = .flashcards(cards: try container.decode([Flashcard].self, forKey: .cards))
        case "fillInBlank":
            self = .fillInBlank(
                prompt: try container.decode(String.self, forKey: .prompt),
                answer: try container.decode(String.self, forKey: .answer),
                options: try container.decodeIfPresent([String].self, forKey: .options),
                explanation: try container.decodeIfPresent(String.self, forKey: .explanation)
            )
        case "matching":
            self = .matching(
                prompt: try container.decodeIfPresent(String.self, forKey: .prompt),
                pairs: try container.decode([MatchingPair].self, forKey: .pairs)
            )
        case "prosCons":
            self = .prosCons(
                pros: try container.decode(ProsConsColumn.self, forKey: .pros),
                cons: try container.decode(ProsConsColumn.self, forKey: .cons)
            )
        case "definition":
            self = .definition(
                term: try container.decode(String.self, forKey: .term),
                definition: try container.decode(String.self, forKey: .definition),
                source: try container.decodeIfPresent(String.self, forKey: .source)
            )
        case "embed":
            self = .embed(
                // Unknown platforms decode to nil so a newer engine platform
                // never fails the block; it falls back to `.x` chrome.
                platform: ((try? container.decodeIfPresent(EmbedPlatform.self, forKey: .platform)) ?? nil) ?? .x,
                url: try container.decode(String.self, forKey: .url),
                title: try container.decodeIfPresent(String.self, forKey: .title),
                html: try container.decodeIfPresent(String.self, forKey: .html)
            )
        case "linkPreview":
            self = .linkPreview(
                url: try container.decode(String.self, forKey: .url),
                title: try container.decode(String.self, forKey: .title),
                domain: try container.decode(String.self, forKey: .domain),
                description: try container.decodeIfPresent(String.self, forKey: .description),
                imageURL: try container.decodeIfPresent(String.self, forKey: .imageURL)
            )
        case "carousel":
            self = .carousel(items: try container.decode([CarouselItem].self, forKey: .items))
        case "map":
            self = .map(
                title: try container.decodeIfPresent(String.self, forKey: .title),
                places: try container.decode([MapPlace].self, forKey: .places)
            )
        case "hero":
            self = .hero(
                url: try container.decode(String.self, forKey: .url),
                title: try container.decodeIfPresent(String.self, forKey: .title),
                subtitle: try container.decodeIfPresent(String.self, forKey: .subtitle)
            )
        case "audioClip":
            self = .audioClip(
                url: try container.decode(String.self, forKey: .url),
                startSeconds: try container.decodeIfPresent(Int.self, forKey: .startSeconds),
                endSeconds: try container.decodeIfPresent(Int.self, forKey: .endSeconds),
                title: try container.decodeIfPresent(String.self, forKey: .title)
            )
        case "toc":
            self = .toc(
                title: try container.decodeIfPresent(String.self, forKey: .title),
                items: try container.decode([String].self, forKey: .items)
            )
        case "math":
            self = .math(
                latex: try container.decode(String.self, forKey: .latex),
                caption: try container.decodeIfPresent(String.self, forKey: .caption)
            )
        default:
            let raw = try JSONValue(from: decoder)
            self = .unsupported(type: type, payload: raw)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        switch self {
        case .kicker(let text):
            try container.encode("kicker", forKey: .type)
            try container.encode(text, forKey: .text)
        case .heading(let text):
            try container.encode("heading", forKey: .type)
            try container.encode(text, forKey: .text)
        case .subheading(let text):
            try container.encode("subheading", forKey: .type)
            try container.encode(text, forKey: .text)
        case .text(let text):
            try container.encode("text", forKey: .type)
            try container.encode(text, forKey: .text)
        case .quote(let text, let author, let source):
            try container.encode("quote", forKey: .type)
            try container.encode(text, forKey: .text)
            try container.encodeIfPresent(author, forKey: .author)
            try container.encodeIfPresent(source, forKey: .source)
        case .divider:
            try container.encode("divider", forKey: .type)
        case .continuation:
            try container.encode("continuation", forKey: .type)
        case .spacer:
            try container.encode("spacer", forKey: .type)
        case .image(let url, let caption, let systemIcon):
            try container.encode("image", forKey: .type)
            try container.encodeIfPresent(url, forKey: .url)
            try container.encodeIfPresent(caption, forKey: .caption)
            try container.encode(systemIcon, forKey: .systemIcon)
        case .video(let youtubeID, let title):
            try container.encode("video", forKey: .type)
            try container.encode(youtubeID, forKey: .youtubeID)
            try container.encodeIfPresent(title, forKey: .title)
        case .audio(let url, let title, let subtitle):
            try container.encode("audio", forKey: .type)
            try container.encode(url, forKey: .url)
            try container.encode(title, forKey: .title)
            try container.encodeIfPresent(subtitle, forKey: .subtitle)
        case .linkCard(let url, let title, let domain):
            try container.encode("linkCard", forKey: .type)
            try container.encode(url, forKey: .url)
            try container.encode(title, forKey: .title)
            try container.encode(domain, forKey: .domain)
        case .figure(let url, let caption, let credit, let systemIcon):
            try container.encode("figure", forKey: .type)
            try container.encode(url, forKey: .url)
            try container.encodeIfPresent(caption, forKey: .caption)
            try container.encodeIfPresent(credit, forKey: .credit)
            try container.encodeIfPresent(systemIcon, forKey: .systemIcon)
        case .gallery(let images, let columns):
            try container.encode("gallery", forKey: .type)
            try container.encode(images, forKey: .images)
            try container.encodeIfPresent(columns, forKey: .columns)
        case .clip(let url, let startSeconds, let endSeconds, let title, let posterURL, let platform):
            try container.encode("clip", forKey: .type)
            try container.encode(url, forKey: .url)
            try container.encode(startSeconds, forKey: .startSeconds)
            try container.encodeIfPresent(endSeconds, forKey: .endSeconds)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encodeIfPresent(posterURL, forKey: .posterURL)
            try container.encodeIfPresent(platform, forKey: .platform)
        case .callout(let style, let title, let text):
            try container.encode("callout", forKey: .type)
            try container.encode(style, forKey: .style)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encode(text, forKey: .text)
        case .bullets(let items):
            try container.encode("bullets", forKey: .type)
            try container.encode(items, forKey: .items)
        case .numbered(let items):
            try container.encode("numbered", forKey: .type)
            try container.encode(items, forKey: .items)
        case .metrics(let stats):
            try container.encode("metrics", forKey: .type)
            try container.encode(stats, forKey: .stats)
        case .lineChart(let title, let xLabels, let series):
            try container.encode("lineChart", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encode(xLabels, forKey: .xLabels)
            try container.encode(series, forKey: .series)
        case .barChart(let title, let items):
            try container.encode("barChart", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encode(items, forKey: .items)
        case .table(let headers, let rows):
            try container.encode("table", forKey: .type)
            try container.encode(headers, forKey: .headers)
            try container.encode(rows, forKey: .rows)
        case .timeline(let items):
            try container.encode("timeline", forKey: .type)
            try container.encode(items, forKey: .items)
        case .code(let code, let language):
            try container.encode("code", forKey: .type)
            try container.encode(code, forKey: .text)
            try container.encode(language, forKey: .language)
        case .bigStat(let value, let label, let delta):
            try container.encode("bigStat", forKey: .type)
            try container.encode(value, forKey: .value)
            try container.encode(label, forKey: .label)
            try container.encodeIfPresent(delta, forKey: .delta)
        case .checklist(let items):
            try container.encode("checklist", forKey: .type)
            try container.encode(items, forKey: .items)
        case .quiz(let question, let options, let correctIndex, let explanation):
            try container.encode("quiz", forKey: .type)
            try container.encode(question, forKey: .question)
            try container.encode(options, forKey: .options)
            try container.encode(correctIndex, forKey: .correctIndex)
            try container.encodeIfPresent(explanation, forKey: .explanation)
        case .servingsScaler(let baseServings, let ingredients):
            try container.encode("servingsScaler", forKey: .type)
            try container.encode(baseServings, forKey: .baseServings)
            try container.encode(ingredients, forKey: .ingredients)
        case .timer(let label, let seconds):
            try container.encode("timer", forKey: .type)
            try container.encode(label, forKey: .label)
            try container.encode(seconds, forKey: .seconds)
        case .reveal(let title, let blocks):
            try container.encode("reveal", forKey: .type)
            try container.encode(title, forKey: .title)
            try container.encode(blocks, forKey: .blocks)
        case .orderExercise(let prompt, let items, let correctOrder):
            try container.encode("orderExercise", forKey: .type)
            try container.encode(prompt, forKey: .prompt)
            try container.encode(items, forKey: .items)
            try container.encode(correctOrder, forKey: .correctOrder)
        case .heatmap(let title, let xLabels, let yLabels, let values, let minLabel, let maxLabel):
            try container.encode("heatmap", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encode(xLabels, forKey: .xLabels)
            try container.encode(yLabels, forKey: .yLabels)
            try container.encode(values, forKey: .values)
            try container.encodeIfPresent(minLabel, forKey: .minLabel)
            try container.encodeIfPresent(maxLabel, forKey: .maxLabel)
        case .scatter(let title, let xLabel, let yLabel, let points):
            try container.encode("scatter", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encodeIfPresent(xLabel, forKey: .xLabel)
            try container.encodeIfPresent(yLabel, forKey: .yLabel)
            try container.encode(points, forKey: .points)
        case .pie(let title, let items):
            try container.encode("pie", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encode(items, forKey: .items)
        case .areaChart(let title, let xLabels, let series):
            try container.encode("areaChart", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encode(xLabels, forKey: .xLabels)
            try container.encode(series, forKey: .series)
        case .stackedBar(let title, let categories, let series):
            try container.encode("stackedBar", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encode(categories, forKey: .categories)
            try container.encode(series, forKey: .series)
        case .gauge(let value, let label, let detail):
            try container.encode("gauge", forKey: .type)
            try container.encode(value, forKey: .value)
            try container.encode(label, forKey: .label)
            try container.encodeIfPresent(detail, forKey: .detail)
        case .histogram(let title, let bins):
            try container.encode("histogram", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encode(bins, forKey: .bins)
        case .radar(let title, let axes, let series):
            try container.encode("radar", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encode(axes, forKey: .axes)
            try container.encode(series, forKey: .series)
        case .flashcards(let cards):
            try container.encode("flashcards", forKey: .type)
            try container.encode(cards, forKey: .cards)
        case .fillInBlank(let prompt, let answer, let options, let explanation):
            try container.encode("fillInBlank", forKey: .type)
            try container.encode(prompt, forKey: .prompt)
            try container.encode(answer, forKey: .answer)
            try container.encodeIfPresent(options, forKey: .options)
            try container.encodeIfPresent(explanation, forKey: .explanation)
        case .matching(let prompt, let pairs):
            try container.encode("matching", forKey: .type)
            try container.encodeIfPresent(prompt, forKey: .prompt)
            try container.encode(pairs, forKey: .pairs)
        case .prosCons(let pros, let cons):
            try container.encode("prosCons", forKey: .type)
            try container.encode(pros, forKey: .pros)
            try container.encode(cons, forKey: .cons)
        case .definition(let term, let definition, let source):
            try container.encode("definition", forKey: .type)
            try container.encode(term, forKey: .term)
            try container.encode(definition, forKey: .definition)
            try container.encodeIfPresent(source, forKey: .source)
        case .embed(let platform, let url, let title, let html):
            try container.encode("embed", forKey: .type)
            try container.encode(platform, forKey: .platform)
            try container.encode(url, forKey: .url)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encodeIfPresent(html, forKey: .html)
        case .linkPreview(let url, let title, let domain, let description, let imageURL):
            try container.encode("linkPreview", forKey: .type)
            try container.encode(url, forKey: .url)
            try container.encode(title, forKey: .title)
            try container.encode(domain, forKey: .domain)
            try container.encodeIfPresent(description, forKey: .description)
            try container.encodeIfPresent(imageURL, forKey: .imageURL)
        case .carousel(let items):
            try container.encode("carousel", forKey: .type)
            try container.encode(items, forKey: .items)
        case .map(let title, let places):
            try container.encode("map", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encode(places, forKey: .places)
        case .hero(let url, let title, let subtitle):
            try container.encode("hero", forKey: .type)
            try container.encode(url, forKey: .url)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encodeIfPresent(subtitle, forKey: .subtitle)
        case .audioClip(let url, let startSeconds, let endSeconds, let title):
            try container.encode("audioClip", forKey: .type)
            try container.encode(url, forKey: .url)
            try container.encodeIfPresent(startSeconds, forKey: .startSeconds)
            try container.encodeIfPresent(endSeconds, forKey: .endSeconds)
            try container.encodeIfPresent(title, forKey: .title)
        case .toc(let title, let items):
            try container.encode("toc", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encode(items, forKey: .items)
        case .math(let latex, let caption):
            try container.encode("math", forKey: .type)
            try container.encode(latex, forKey: .latex)
            try container.encodeIfPresent(caption, forKey: .caption)
        case .unsupported(_, let payload):
            // Write the original object back untouched (its `type` included).
            try payload.encode(to: encoder)
        }
    }
}

/// A single labeled metric for `.metrics` grids and stat-style cards.
struct StatItem: Codable, Identifiable, Sendable, Equatable, Hashable {
    let id: String
    var label: String
    var value: String
    /// e.g. "+18.7% QoQ". Optional.
    var delta: String?

    init(id: String = UUID().uuidString, label: String, value: String, delta: String? = nil) {
        self.id = id
        self.label = label
        self.value = value
        self.delta = delta
    }
}
