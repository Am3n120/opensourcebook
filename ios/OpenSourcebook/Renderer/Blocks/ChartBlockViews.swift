import SwiftUI

/// Custom-drawn chart blocks (no Charts framework dependency).

// MARK: - Line chart

struct LineChartBlockView: View {
    let title: String?
    let xLabels: [String]
    let series: [LineSeries]

    private var allValues: [Double] { series.flatMap(\.values) }
    private var minValue: Double { allValues.min() ?? 0 }
    private var maxValue: Double { allValues.max() ?? 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }

            HStack(alignment: .center, spacing: OpenSourcebookTheme.Spacing.xs) {
                VStack(alignment: .trailing) {
                    Text(format(maxValue))
                    Spacer()
                    Text(format(minValue))
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)

                Canvas { context, size in
                    // Inset so first/last dots (radius 3) and the 2.5pt stroke
                    // are never clipped by the canvas edges.
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

    private func format(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(format: "%.1f", value)
    }
}

// MARK: - Bar chart

struct BarChartBlockView: View {
    let title: String?
    let items: [BarItem]

    @State private var appeared = false

    private var maxValue: Double { items.map(\.value).max() ?? 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            if let title {
                Text(title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }

            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                    Text(item.label)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .frame(width: 76, alignment: .leading)
                        .lineLimit(1)

                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r8, style: .continuous)
                                .fill(OpenSourcebookTheme.Colors.fill)
                            RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r8, style: .continuous)
                                .fill(OpenSourcebookTheme.Colors.primary)
                                .frame(width: barWidth(for: item, in: geo.size.width))
                        }
                    }
                    .frame(height: 22)

                    Text(item.displayValue)
                        .font(OpenSourcebookTheme.Fonts.label)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        .lineLimit(1)
                        // Never truncate: long values grow leftward into the
                        // flexible bar area instead of clipping at the edge.
                        .fixedSize(horizontal: true, vertical: false)
                        .frame(minWidth: 56, alignment: .trailing)
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
        .onAppear {
            withAnimation(OpenSourcebookTheme.Motion.gentle) { appeared = true }
        }
    }

    private func barWidth(for item: BarItem, in total: CGFloat) -> CGFloat {
        guard appeared, maxValue > 0 else { return 0 }
        return total * CGFloat(item.value / maxValue)
    }
}
