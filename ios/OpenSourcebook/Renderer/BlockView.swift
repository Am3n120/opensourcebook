import SwiftUI

/// Scroll anchor for a heading block, derived from its text — `toc` items
/// echo the exact heading text they jump to.
private func blockHeadingAnchor(_ text: String) -> String {
    "heading-\(text)"
}

/// Dispatches a single block to its view. A bit stacks these top to bottom
/// (`BitView`); `RevealBlockView` nests them.
struct BlockView: View {
    let block: Block
    /// What a tapped `toc` item does; a bit has no page to scroll, so the
    /// default does nothing.
    var onTocSelect: (String) -> Void = { _ in }

    var body: some View {
        switch block {
        // Text & structure
        case .kicker(let text): KickerBlockView(text: text)
        case .heading(let text):
            HeadingBlockView(text: text)
                .id(blockHeadingAnchor(text))
        case .subheading(let text): SubheadingBlockView(text: text)
        case .text(let text): TextBlockView(text: text)
        case .quote(let text, let author, let source):
            QuoteBlockView(text: text, author: author, source: source)
        case .divider: DividerBlockView()
        case .continuation: ContinuationBlockView()
        case .spacer: SpacerBlockView()

        // Media & references
        case .image(let url, let caption, let systemIcon):
            ImageBlockView(url: url, caption: caption, systemIcon: systemIcon)
        case .video(let youtubeID, let title):
            VideoBlockView(youtubeID: youtubeID, title: title)
        case .audio(let url, let title, let subtitle):
            AudioBlockView(url: url, title: title, subtitle: subtitle)
        case .linkCard(let url, let title, let domain):
            LinkCardBlockView(url: url, title: title, domain: domain)

        // Asset-bound media (engine-extracted)
        case .figure(let url, let caption, let credit, let systemIcon):
            FigureBlockView(url: url, caption: caption, credit: credit, systemIcon: systemIcon)
        case .gallery(let images, let columns):
            GalleryBlockView(images: images, columns: columns)
        case .clip(let url, let startSeconds, let endSeconds, let title, let posterURL, let platform):
            ClipBlockView(url: url, startSeconds: startSeconds, endSeconds: endSeconds,
                          title: title, posterURL: posterURL, platform: platform)

        // Data & structured content
        case .callout(let style, let title, let text):
            CalloutBlockView(style: style, title: title, text: text)
        case .bullets(let items): BulletsBlockView(items: items)
        case .numbered(let items): NumberedBlockView(items: items)
        case .metrics(let stats): MetricsBlockView(stats: stats)
        case .lineChart(let title, let xLabels, let series):
            LineChartBlockView(title: title, xLabels: xLabels, series: series)
        case .barChart(let title, let items):
            BarChartBlockView(title: title, items: items)
        case .table(let headers, let rows):
            TableBlockView(headers: headers, rows: rows)
        case .timeline(let items): TimelineBlockView(items: items)
        case .code(let code, let language):
            CodeBlockView(code: code, language: language)
        case .bigStat(let value, let label, let delta):
            BigStatBlockView(value: value, label: label, delta: delta)

        // Interactive
        case .checklist(let items): ChecklistBlockView(items: items)
        case .quiz(let question, let options, let correctIndex, let explanation):
            QuizBlockView(question: question, options: options,
                          correctIndex: correctIndex, explanation: explanation)
        case .servingsScaler(let baseServings, let ingredients):
            ServingsScalerBlockView(baseServings: baseServings, ingredients: ingredients)
        case .timer(let label, let seconds):
            TimerBlockView(label: label, seconds: seconds)
        case .reveal(let title, let blocks):
            RevealBlockView(title: title, blocks: blocks)
        case .orderExercise(let prompt, let items, let correctOrder):
            OrderExerciseBlockView(prompt: prompt, items: items, correctOrder: correctOrder)

        // Extended charts
        case .heatmap(let title, let xLabels, let yLabels, let values, let minLabel, let maxLabel):
            HeatmapBlockView(title: title, xLabels: xLabels, yLabels: yLabels,
                             values: values, minLabel: minLabel, maxLabel: maxLabel)
        case .scatter(let title, let xLabel, let yLabel, let points):
            ScatterBlockView(title: title, xLabel: xLabel, yLabel: yLabel, points: points)
        case .pie(let title, let items):
            PieBlockView(title: title, items: items)
        case .areaChart(let title, let xLabels, let series):
            AreaChartBlockView(title: title, xLabels: xLabels, series: series)
        case .stackedBar(let title, let categories, let series):
            StackedBarBlockView(title: title, categories: categories, series: series)
        case .gauge(let value, let label, let detail):
            GaugeBlockView(value: value, label: label, detail: detail)
        case .histogram(let title, let bins):
            HistogramBlockView(title: title, bins: bins)
        case .radar(let title, let axes, let series):
            RadarBlockView(title: title, axes: axes, series: series)

        // Link & media
        case .embed(let platform, let url, let title, let html):
            EmbedBlockView(platform: platform, url: url, title: title, html: html)
        case .linkPreview(let url, let title, let domain, let description, let imageURL):
            LinkPreviewBlockView(url: url, title: title, domain: domain,
                                 description: description, imageURL: imageURL)
        case .carousel(let items):
            CarouselBlockView(items: items)
        case .map(let title, let places):
            MapBlockView(title: title, places: places)
        case .hero(let url, let title, let subtitle):
            HeroBlockView(url: url, title: title, subtitle: subtitle)
        case .audioClip(let url, let startSeconds, let endSeconds, let title):
            AudioClipBlockView(url: url, startSeconds: startSeconds,
                               endSeconds: endSeconds, title: title)

        // Learning
        case .flashcards(let cards):
            FlashcardsBlockView(cards: cards)
        case .fillInBlank(let prompt, let answer, let options, let explanation):
            FillInBlankBlockView(prompt: prompt, answer: answer,
                                 options: options, explanation: explanation)
        case .matching(let prompt, let pairs):
            MatchingBlockView(prompt: prompt, pairs: pairs)

        // Document structure
        case .prosCons(let pros, let cons):
            ProsConsBlockView(pros: pros, cons: cons)
        case .definition(let term, let definition, let source):
            DefinitionBlockView(term: term, definition: definition, source: source)
        case .toc(let title, let items):
            TocBlockView(title: title, items: items, onSelect: onTocSelect)
        case .math(let latex, let caption):
            MathBlockView(latex: latex, caption: caption)

        // Forward compatibility
        case .unsupported(let type, _):
            UnsupportedBlockView(type: type)
        }
    }
}

/// Quiet placeholder for a block type this build cannot render. The data is
/// still in the output; a newer app shows it.
struct UnsupportedBlockView: View {
    let type: String

    var body: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            Image(systemName: "square.dashed")
                .font(.system(size: 13, weight: .semibold))
            Text("This part needs a newer version of Open Sourcebook (\(type)).")
                .font(OpenSourcebookTheme.Fonts.caption)
        }
        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
        .padding(.vertical, OpenSourcebookTheme.Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OpenSourcebookTheme.Colors.fill)
        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
        .accessibilityIdentifier("unsupported-block")
    }
}

#Preview {
    BitView(bit: Bit(id: "b1", section: "Preview", blocks: [
        .kicker("1 · Start"),
        .heading("A heading"),
        .text("Body with **bold**, *italic* and `code`."),
        .quote(text: "Stay hungry.", author: "Anon", source: nil),
        .callout(style: .success, title: "Tip", text: "Keep going."),
        .numbered(["First", "Second"]),
        .unsupported(type: "hologram", payload: .object([:]))
    ]))
    .background(OpenSourcebookTheme.Colors.background)
}
