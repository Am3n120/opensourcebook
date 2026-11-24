import SwiftUI

/// Extended chart blocks (heatmap, scatter, pie, areaChart, stackedBar, gauge,
/// histogram, radar), custom-drawn with SwiftUI Canvas — no Charts framework
/// dependency. Follows the line/bar chart idioms in `ChartBlockViews`.

// MARK: - Shared helpers

/// Integers print without a fraction, everything else with one decimal.
private func openSourcebookChartFormat(_ value: Double) -> String {
    value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(format: "%.1f", value)
}

/// Series colors cycle through the `SeriesColor` palette.
private func openSourcebookChartPaletteColor(at index: Int) -> Color {
    let all = SeriesColor.allCases
    return all[index % all.count].color
}

/// Compact card shown when a chart payload carries nothing drawable.
private struct ChartEmptyFallbackView: View {
    let title: String?

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }
            Text("No data")
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .openSourcebookCardStyle()
    }
}

// MARK: - Heatmap

struct HeatmapBlockView: View {
    let title: String?
    let xLabels: [String]
    let yLabels: [String]
    let values: [[Double]]
    let minLabel: String?
    let maxLabel: String?

    private var rows: Int { values.count }
    private var cols: Int { values.map(\.count).max() ?? 0 }
    private var flatValues: [Double] { values.flatMap { $0 } }
    private var minValue: Double { flatValues.min() ?? 0 }
    private var maxValue: Double { flatValues.max() ?? 1 }

    /// Taller grids for more rows, clamped so a single row still reads.
    private var gridHeight: CGFloat {
        min(220, max(52, CGFloat(max(rows, 1)) * 30))
    }

    var body: some View {
        if rows == 0 || cols == 0 {
            ChartEmptyFallbackView(title: title)
        } else {
            chartContent
        }
    }

    private var chartContent: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }

            HStack(alignment: .center, spacing: OpenSourcebookTheme.Spacing.xs) {
                VStack(spacing: 0) {
                    ForEach(Array(yLabels.prefix(rows).enumerated()), id: \.offset) { _, label in
                        Text(label)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .frame(height: gridHeight / CGFloat(max(rows, 1)))
                    }
                    Spacer(minLength: 0)
                }
                .frame(width: 44)

                Canvas { context, size in
                    let gutter: CGFloat = 2
                    let cellWidth = size.width / CGFloat(cols)
                    let cellHeight = size.height / CGFloat(rows)
                    let range = maxValue - minValue
                    for row in 0..<rows {
                        for col in 0..<cols {
                            let rect = CGRect(x: CGFloat(col) * cellWidth + gutter / 2,
                                              y: CGFloat(row) * cellHeight + gutter / 2,
                                              width: max(cellWidth - gutter, 1),
                                              height: max(cellHeight - gutter, 1))
                            let cell = Path(roundedRect: rect, cornerRadius: 3)
                            // Ragged rows: a missing cell renders as neutral fill.
                            guard col < values[row].count else {
                                context.fill(cell, with: .color(OpenSourcebookTheme.Colors.fill))
                                continue
                            }
                            let t = range > 0 ? (values[row][col] - minValue) / range : 0.5
                            context.fill(cell, with: .color(heatColor(t)))
                        }
                    }
                }
                .frame(height: gridHeight)
            }

            if !xLabels.isEmpty {
                HStack {
                    Text(xLabels.first ?? "")
                    Spacer()
                    if xLabels.count > 2 {
                        Text(xLabels[xLabels.count / 2])
                        Spacer()
                    }
                    if xLabels.count > 1 { Text(xLabels.last ?? "") }
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }

            HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                Text(minLabel ?? openSourcebookChartFormat(minValue))
                LinearGradient(colors: [heatColor(0), heatColor(1)],
                               startPoint: .leading, endPoint: .trailing)
                    .frame(height: 8)
                    .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r4, style: .continuous))
                Text(maxLabel ?? openSourcebookChartFormat(maxValue))
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }

    /// primary (#6C5CE7) → accent (#FFB020) intensity ramp.
    private func heatColor(_ t: Double) -> Color {
        let clamped = min(max(t, 0), 1)
        func lerp(_ a: Double, _ b: Double) -> Double { (a + (b - a) * clamped) / 255 }
        return Color(.sRGB, red: lerp(0x6C, 0xFF), green: lerp(0x5C, 0xB0), blue: lerp(0xE7, 0x20), opacity: 1)
    }
}

// MARK: - Scatter

struct ScatterBlockView: View {
    let title: String?
    let xLabel: String?
    let yLabel: String?
    let points: [ScatterPoint]

    @State private var selectedIndex: Int? = nil

    private let plotInset: CGFloat = 10
    /// Extra top room so in-canvas point labels are never clipped.
    private let plotTop: CGFloat = 18

    private var xMin: Double { points.map(\.x).min() ?? 0 }
    private var xMax: Double { points.map(\.x).max() ?? 1 }
    private var yMin: Double { points.map(\.y).min() ?? 0 }
    private var yMax: Double { points.map(\.y).max() ?? 1 }

    var body: some View {
        if points.isEmpty {
            ChartEmptyFallbackView(title: title)
        } else {
            chartContent
        }
    }

    private var chartContent: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }
            if let yLabel {
                Text(yLabel)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }

            HStack(alignment: .center, spacing: OpenSourcebookTheme.Spacing.xs) {
                VStack(alignment: .trailing) {
                    Text(openSourcebookChartFormat(yMax))
                    Spacer()
                    Text(openSourcebookChartFormat(yMin))
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)

                GeometryReader { geo in
                    Canvas { context, size in
                        // Grid lines
                        for step in 0...2 {
                            let y = plotTop + (size.height - plotTop - plotInset) * CGFloat(step) / 2
                            var grid = Path()
                            grid.move(to: CGPoint(x: 0, y: y))
                            grid.addLine(to: CGPoint(x: size.width, y: y))
                            context.stroke(grid, with: .color(OpenSourcebookTheme.Colors.border), lineWidth: 1)
                        }

                        let showAllLabels = points.count <= 12
                        for (index, point) in points.enumerated() {
                            let p = plotPoint(for: point, in: size)
                            let dot = Path(ellipseIn: CGRect(x: p.x - 4, y: p.y - 4, width: 8, height: 8))
                            context.fill(dot, with: .color(OpenSourcebookTheme.Colors.primary))
                            if index == selectedIndex {
                                let ring = Path(ellipseIn: CGRect(x: p.x - 7, y: p.y - 7, width: 14, height: 14))
                                context.stroke(ring, with: .color(OpenSourcebookTheme.Colors.accent), lineWidth: 2)
                            }
                            if showAllLabels || index == selectedIndex {
                                let text = point.label ?? "(\(openSourcebookChartFormat(point.x)), \(openSourcebookChartFormat(point.y)))"
                                context.draw(
                                    Text(text)
                                        .font(.system(size: 9, weight: .medium))
                                        .foregroundStyle(index == selectedIndex ? OpenSourcebookTheme.Colors.text : OpenSourcebookTheme.Colors.muted),
                                    at: CGPoint(x: p.x, y: p.y - 12), anchor: .center)
                            }
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { location in
                        selectNearest(to: location, in: geo.size)
                    }
                }
                .frame(height: 160)
            }

            HStack {
                Text(openSourcebookChartFormat(xMin))
                Spacer()
                if let xLabel {
                    Text(xLabel)
                    Spacer()
                }
                Text(openSourcebookChartFormat(xMax))
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }

    private func plotPoint(for point: ScatterPoint, in size: CGSize) -> CGPoint {
        let xRange = xMax - xMin
        let yRange = yMax - yMin
        let fx = xRange > 0 ? (point.x - xMin) / xRange : 0.5
        let fy = yRange > 0 ? (point.y - yMin) / yRange : 0.5
        return CGPoint(x: plotInset + (size.width - plotInset * 2) * CGFloat(fx),
                       y: plotTop + (size.height - plotTop - plotInset) * CGFloat(1 - fy))
    }

    /// Toggles the nearest point within a 28pt touch target; anything else clears.
    private func selectNearest(to location: CGPoint, in size: CGSize) {
        var best: Int?
        var bestDistance: CGFloat = 28
        for (index, point) in points.enumerated() {
            let p = plotPoint(for: point, in: size)
            let distance = hypot(p.x - location.x, p.y - location.y)
            if distance < bestDistance {
                bestDistance = distance
                best = index
            }
        }
        selectedIndex = best == selectedIndex ? nil : best
    }
}

// MARK: - Pie

struct PieBlockView: View {
    let title: String?
    let items: [PieItem]

    private var total: Double { items.map { max($0.value, 0) }.reduce(0, +) }

    var body: some View {
        if items.isEmpty || total <= 0 {
            ChartEmptyFallbackView(title: title)
        } else {
            chartContent
        }
    }

    private var chartContent: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }

            Canvas { context, size in
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                let outer = min(size.width, size.height) / 2 - 4
                // Donut: inner radius ~60% of the outer.
                let inner = outer * 0.6
                var start = Angle.degrees(-90)
                for (index, item) in items.enumerated() {
                    let value = max(item.value, 0)
                    guard value > 0 else { continue }
                    let end = start + Angle.degrees(360 * value / total)
                    var slice = Path()
                    slice.addArc(center: center, radius: outer, startAngle: start, endAngle: end, clockwise: false)
                    slice.addArc(center: center, radius: inner, startAngle: end, endAngle: start, clockwise: true)
                    slice.closeSubpath()
                    context.fill(slice, with: .color(openSourcebookChartPaletteColor(at: index)))
                    context.stroke(slice, with: .color(OpenSourcebookTheme.Colors.surface), lineWidth: 2)
                    start = end
                }
            }
            .frame(height: 180)

            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                        Circle()
                            .fill(openSourcebookChartPaletteColor(at: index))
                            .frame(width: 8, height: 8)
                        Text(item.label)
                            .font(OpenSourcebookTheme.Fonts.caption)
                            .foregroundStyle(OpenSourcebookTheme.Colors.text)
                            .lineLimit(1)
                        Spacer()
                        Text(item.displayValue ?? openSourcebookChartFormat(item.value))
                            .font(OpenSourcebookTheme.Fonts.label)
                            .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                            .lineLimit(1)
                    }
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }
}

// MARK: - Area chart

struct AreaChartBlockView: View {
    let title: String?
    let xLabels: [String]
    let series: [LineSeries]

    private var allValues: [Double] { series.flatMap(\.values) }
    private var minValue: Double { allValues.min() ?? 0 }
    private var maxValue: Double { allValues.max() ?? 1 }

    var body: some View {
        if series.isEmpty || allValues.isEmpty {
            ChartEmptyFallbackView(title: title)
        } else {
            chartContent
        }
    }

    private var chartContent: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }

            HStack(alignment: .center, spacing: OpenSourcebookTheme.Spacing.xs) {
                VStack(alignment: .trailing) {
                    Text(openSourcebookChartFormat(maxValue))
                    Spacer()
                    Text(openSourcebookChartFormat(minValue))
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)

                Canvas { context, size in
                    // Inset matches the line chart so dots/strokes never clip.
                    let inset: CGFloat = 5
                    let yRange = maxValue - minValue
                    func point(for value: Double, at index: Int, of count: Int) -> CGPoint {
                        let x = count > 1
                            ? inset + (size.width - inset * 2) * CGFloat(index) / CGFloat(count - 1)
                            : size.width / 2
                        let fraction = yRange > 0 ? (value - minValue) / yRange : 0.5
                        let y = inset + (size.height - inset * 2) * (1 - CGFloat(fraction))
                        return CGPoint(x: x, y: y)
                    }

                    // Grid lines
                    for step in 0...2 {
                        let y = inset + (size.height - inset * 2) * CGFloat(step) / 2
                        var grid = Path()
                        grid.move(to: CGPoint(x: 0, y: y))
                        grid.addLine(to: CGPoint(x: size.width, y: y))
                        context.stroke(grid, with: .color(OpenSourcebookTheme.Colors.border), lineWidth: 1)
                    }

                    // Series
                    for line in series {
                        let count = line.values.count
                        guard count > 0 else { continue }
                        var path = Path()
                        for (index, value) in line.values.enumerated() {
                            let p = point(for: value, at: index, of: count)
                            if index == 0 { path.move(to: p) } else { path.addLine(to: p) }
                        }
                        // Gradient fill under the line, down to the plot floor.
                        if count > 1 {
                            var area = path
                            area.addLine(to: CGPoint(x: point(for: line.values[count - 1], at: count - 1, of: count).x,
                                                     y: size.height - inset))
                            area.addLine(to: CGPoint(x: point(for: line.values[0], at: 0, of: count).x,
                                                     y: size.height - inset))
                            area.closeSubpath()
                            context.fill(area, with: .linearGradient(
                                Gradient(colors: [line.color.color.opacity(0.25), line.color.color.opacity(0.02)]),
                                startPoint: CGPoint(x: 0, y: 0),
                                endPoint: CGPoint(x: 0, y: size.height)))
                        }
                        context.stroke(path, with: .color(line.color.color),
                                       style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                        for (index, value) in line.values.enumerated() {
                            let p = point(for: value, at: index, of: count)
                            let dot = Path(ellipseIn: CGRect(x: p.x - 3, y: p.y - 3, width: 6, height: 6))
                            context.fill(dot, with: .color(line.color.color))
                        }
                    }
                }
                .frame(height: 160)
            }

            if !xLabels.isEmpty {
                HStack {
                    Text(xLabels.first ?? "")
                    Spacer()
                    if xLabels.count > 2 {
                        Text(xLabels[xLabels.count / 2])
                        Spacer()
                    }
                    if xLabels.count > 1 { Text(xLabels.last ?? "") }
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }

            if series.count > 1 {
                HStack(spacing: OpenSourcebookTheme.Spacing.md) {
                    ForEach(series, id: \.name) { line in
                        HStack(spacing: OpenSourcebookTheme.Spacing.xxs) {
                            Circle().fill(line.color.color).frame(width: 8, height: 8)
                            Text(line.name)
                                .font(OpenSourcebookTheme.Fonts.label)
                                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        }
                    }
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }
}

// MARK: - Stacked bar

struct StackedBarBlockView: View {
    let title: String?
    let categories: [String]
    let series: [StackedBarSeries]

    private var totals: [Double] {
        categories.indices.map { index in
            series.reduce(0) { $0 + max(stackedValue(at: index, in: $1), 0) }
        }
    }
    private var maxTotal: Double { totals.max() ?? 0 }

    var body: some View {
        if categories.isEmpty || series.isEmpty || maxTotal <= 0 {
            ChartEmptyFallbackView(title: title)
        } else {
            chartContent
        }
    }

    /// A series shorter than `categories` contributes 0 for missing slots.
    private func stackedValue(at index: Int, in series: StackedBarSeries) -> Double {
        index < series.values.count ? series.values[index] : 0
    }

    private var chartContent: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }

            HStack(alignment: .center, spacing: OpenSourcebookTheme.Spacing.xs) {
                VStack(alignment: .trailing) {
                    Text(openSourcebookChartFormat(maxTotal))
                    Spacer()
                    Text("0")
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                // Keep "0" level with the plot baseline, above the label strip.
                .padding(.bottom, 16)

                Canvas { context, size in
                    let inset: CGFloat = 5
                    // Category labels draw inside the canvas, centered under
                    // their own bar — a first/middle/last label row spreads
                    // across the axis and misses most bars.
                    let labelStrip: CGFloat = 16
                    let plotBottom = size.height - labelStrip
                    let slot = size.width / CGFloat(categories.count)
                    let barWidth = min(slot * 0.55, 44)
                    // The font only shrinks when slots get too narrow for 10pt.
                    let labelFont: CGFloat = slot < 60 ? 8 : 10
                    for index in categories.indices {
                        var bottom = plotBottom
                        for bar in series {
                            let value = max(stackedValue(at: index, in: bar), 0)
                            guard value > 0 else { continue }
                            let height = (plotBottom - inset) * CGFloat(value / maxTotal)
                            let rect = CGRect(x: slot * CGFloat(index) + (slot - barWidth) / 2,
                                              y: bottom - height, width: barWidth, height: height)
                            let segment = Path(rect)
                            context.fill(segment, with: .color(bar.color.color))
                            context.stroke(segment, with: .color(OpenSourcebookTheme.Colors.surface), lineWidth: 1)
                            bottom -= height
                        }
                        context.draw(
                            Text(categories[index])
                                .font(.system(size: labelFont, weight: .medium))
                                .foregroundStyle(OpenSourcebookTheme.Colors.muted),
                            at: CGPoint(x: slot * CGFloat(index) + slot / 2,
                                        y: plotBottom + labelStrip / 2),
                            anchor: .center)
                    }
                }
                .frame(height: 176)
            }

            if series.count > 1 {
                HStack(spacing: OpenSourcebookTheme.Spacing.md) {
                    ForEach(series, id: \.name) { bar in
                        HStack(spacing: OpenSourcebookTheme.Spacing.xxs) {
                            Circle().fill(bar.color.color).frame(width: 8, height: 8)
                            Text(bar.name)
                                .font(OpenSourcebookTheme.Fonts.label)
                                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        }
                    }
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }
}

// MARK: - Gauge

struct GaugeBlockView: View {
    let value: Double
    let label: String
    let detail: String?

    /// The engine contract bounds `value` to 0...100; clamp defensively anyway.
    private var fraction: Double { min(max(value, 0), 100) / 100 }

    var body: some View {
        VStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            ZStack(alignment: .bottom) {
                Canvas { context, size in
                    let lineWidth: CGFloat = 14
                    let radius = max(min(size.width / 2, size.height) - lineWidth / 2 - 2, 1)
                    let center = CGPoint(x: size.width / 2, y: size.height - 2)
                    var track = Path()
                    track.addArc(center: center, radius: radius,
                                 startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)
                    context.stroke(track, with: .color(OpenSourcebookTheme.Colors.fill),
                                   style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    if fraction > 0 {
                        var progress = Path()
                        progress.addArc(center: center, radius: radius,
                                        startAngle: .degrees(180), endAngle: .degrees(180 + 180 * fraction),
                                        clockwise: false)
                        context.stroke(progress, with: .color(OpenSourcebookTheme.Colors.primary),
                                       style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    }
                }

                VStack(spacing: OpenSourcebookTheme.Spacing.xxs) {
                    Text(openSourcebookChartFormat(value))
                        .font(OpenSourcebookTheme.Fonts.title)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    Text(label)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                }
                .padding(.bottom, OpenSourcebookTheme.Spacing.xs)
            }
            .frame(height: 120)

            if let detail {
                Text(detail)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }
}

// MARK: - Histogram

struct HistogramBlockView: View {
    let title: String?
    let bins: [HistogramBin]

    private var maxCount: Double { bins.map { max($0.count, 0) }.max() ?? 0 }

    var body: some View {
        if bins.isEmpty || maxCount <= 0 {
            ChartEmptyFallbackView(title: title)
        } else {
            chartContent
        }
    }

    private var chartContent: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }

            HStack(alignment: .center, spacing: OpenSourcebookTheme.Spacing.xs) {
                VStack(alignment: .trailing) {
                    Text(openSourcebookChartFormat(maxCount))
                    Spacer()
                    Text("0")
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                // Keep "0" level with the plot baseline, above the label strip.
                .padding(.bottom, 16)

                Canvas { context, size in
                    let top: CGFloat = 16
                    // Bin labels draw inside the canvas, centered under their
                    // own bar — a first/middle/last label row spreads across
                    // the axis and misses most bins.
                    let labelStrip: CGFloat = 16
                    let plotBottom = size.height - labelStrip
                    let plotHeight = plotBottom - top
                    let barWidth = size.width / CGFloat(bins.count)
                    // The font only shrinks when slots get too narrow for 10pt.
                    let labelFont: CGFloat = barWidth < 60 ? 8 : 10
                    for (index, bin) in bins.enumerated() {
                        let count = max(bin.count, 0)
                        let height = plotHeight * CGFloat(count / maxCount)
                        let rect = CGRect(x: CGFloat(index) * barWidth,
                                          y: plotBottom - height,
                                          width: barWidth, height: height)
                        // Contiguous bars: full-width rects, hairline separators only.
                        if height > 0 {
                            let bar = Path(rect)
                            context.fill(bar, with: .color(OpenSourcebookTheme.Colors.primary))
                            context.stroke(bar, with: .color(OpenSourcebookTheme.Colors.surface), lineWidth: 1)
                        }
                        if bins.count <= 10 {
                            context.draw(
                                Text(openSourcebookChartFormat(bin.count))
                                    .font(.system(size: 9, weight: .medium))
                                    .foregroundStyle(OpenSourcebookTheme.Colors.muted),
                                at: CGPoint(x: rect.midX, y: rect.minY - 8), anchor: .center)
                        }
                        context.draw(
                            Text(bin.label)
                                .font(.system(size: labelFont, weight: .medium))
                                .foregroundStyle(OpenSourcebookTheme.Colors.muted),
                            at: CGPoint(x: rect.midX, y: plotBottom + labelStrip / 2),
                            anchor: .center)
                    }
                    // Baseline
                    var baseline = Path()
                    baseline.move(to: CGPoint(x: 0, y: plotBottom))
                    baseline.addLine(to: CGPoint(x: size.width, y: plotBottom))
                    context.stroke(baseline, with: .color(OpenSourcebookTheme.Colors.border), lineWidth: 1)
                }
                .frame(height: 160)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }
}

// MARK: - Radar

struct RadarBlockView: View {
    let title: String?
    let axes: [String]
    let series: [RadarSeries]

    /// Global normalization: one scale across every axis and series, so the
    /// polygon's shape carries the data. Per-axis scaling made each spoke hit
    /// the outer ring regardless of magnitude (a perfect diamond for
    /// 512/2048/64/64); a series shorter than `axes` reads 0 for missing slots.
    private var globalMax: Double {
        let maxValue = series.flatMap(\.values).max() ?? 0
        return maxValue > 0 ? maxValue : 1
    }

    var body: some View {
        if axes.count < 3 || series.isEmpty {
            ChartEmptyFallbackView(title: title)
        } else {
            chartContent
        }
    }

    private var chartContent: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }

            Canvas { context, size in
                let count = axes.count
                let center = CGPoint(x: size.width / 2, y: size.height / 2)
                // 20pt padding keeps the per-axis captions inside the canvas.
                let radius = max(min(size.width, size.height) / 2 - 20, 1)
                func vertex(_ axis: Int, _ fraction: Double) -> CGPoint {
                    let angle = -Double.pi / 2 + 2 * Double.pi * Double(axis) / Double(count)
                    return CGPoint(x: center.x + radius * CGFloat(cos(angle)) * CGFloat(fraction),
                                   y: center.y + radius * CGFloat(sin(angle)) * CGFloat(fraction))
                }

                // Web rings
                for step in 1...3 {
                    var ring = Path()
                    for axis in 0..<count {
                        let p = vertex(axis, Double(step) / 3)
                        if axis == 0 { ring.move(to: p) } else { ring.addLine(to: p) }
                    }
                    ring.closeSubpath()
                    context.stroke(ring, with: .color(OpenSourcebookTheme.Colors.border), lineWidth: 1)
                }
                // Spokes
                for axis in 0..<count {
                    var spoke = Path()
                    spoke.move(to: center)
                    spoke.addLine(to: vertex(axis, 1))
                    context.stroke(spoke, with: .color(OpenSourcebookTheme.Colors.border), lineWidth: 1)
                }

                // Series polygons
                for entry in series {
                    var polygon = Path()
                    for axis in 0..<count {
                        let raw = axis < entry.values.count ? entry.values[axis] : 0
                        let p = vertex(axis, min(max(raw / globalMax, 0), 1))
                        if axis == 0 { polygon.move(to: p) } else { polygon.addLine(to: p) }
                    }
                    polygon.closeSubpath()
                    if series.count <= 3 {
                        context.fill(polygon, with: .color(entry.color.color.opacity(0.15)))
                    }
                    context.stroke(polygon, with: .color(entry.color.color),
                                   style: StrokeStyle(lineWidth: 2, lineJoin: .round))
                }

                // Axis captions
                for axis in 0..<count {
                    context.draw(
                        Text(axes[axis])
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(OpenSourcebookTheme.Colors.muted),
                        at: vertex(axis, 1.15), anchor: .center)
                }
            }
            .frame(height: 200)

            if series.count > 1 {
                HStack(spacing: OpenSourcebookTheme.Spacing.md) {
                    ForEach(series, id: \.name) { entry in
                        HStack(spacing: OpenSourcebookTheme.Spacing.xxs) {
                            Circle().fill(entry.color.color).frame(width: 8, height: 8)
                            Text(entry.name)
                                .font(OpenSourcebookTheme.Fonts.label)
                                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        }
                    }
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }
}
