import SwiftUI

/// Renderers for the document-structure blocks: pros/cons, definition,
/// table of contents and math. All internal to the module; dispatched by
/// `BlockView`.

// MARK: - Pros / cons

struct ProsConsBlockView: View {
    let pros: ProsConsColumn
    let cons: ProsConsColumn

    var body: some View {
        HStack(alignment: .top, spacing: OpenSourcebookTheme.Spacing.sm) {
            columnView(pros, fallbackTitle: "Pros", icon: "plus",
                       tint: OpenSourcebookTheme.Colors.success, softTint: OpenSourcebookTheme.Colors.successSoft)
            columnView(cons, fallbackTitle: "Cons", icon: "minus",
                       tint: OpenSourcebookTheme.Colors.accent, softTint: OpenSourcebookTheme.Colors.accentSoft)
        }
    }

    private func columnView(_ column: ProsConsColumn, fallbackTitle: String, icon: String,
                            tint: Color, softTint: Color) -> some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 22, height: 22)
                    .background(tint)
                    .clipShape(Circle())
                Text(column.title ?? fallbackTitle)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }

            ForEach(column.items, id: \.self) { item in
                HStack(alignment: .top, spacing: OpenSourcebookTheme.Spacing.xs) {
                    Circle()
                        .fill(tint)
                        .frame(width: 5, height: 5)
                        .padding(.top, 6)
                    Text(InlineMarkdown.parse(item))
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .lineSpacing(2)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(softTint)
        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r20, style: .continuous))
    }
}

// MARK: - Definition

struct DefinitionBlockView: View {
    let term: String
    let definition: String
    let source: String?

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            Text(term)
                .font(OpenSourcebookTheme.Fonts.heading)
                .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .fixedSize(horizontal: false, vertical: true)

            Text(InlineMarkdown.parse(definition))
                .font(OpenSourcebookTheme.Fonts.body)
                .lineSpacing(5)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .fixedSize(horizontal: false, vertical: true)

            if let source {
                Text(source)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OpenSourcebookTheme.Colors.primaryGhost)
        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r20, style: .continuous))
    }
}

// MARK: - Table of contents

struct TocBlockView: View {
    let title: String?
    let items: [String]
    var onSelect: (String) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            Text(title ?? "Contents")
                .font(OpenSourcebookTheme.Fonts.bodySemibold)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)

            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    Button {
                        onSelect(item)
                    } label: {
                        HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                            Text("\(index + 1)")
                                .font(OpenSourcebookTheme.Fonts.label)
                                .foregroundStyle(.white)
                                .frame(width: 22, height: 22)
                                .background(OpenSourcebookTheme.Colors.primary)
                                .clipShape(Circle())

                            Text(item)
                                .font(OpenSourcebookTheme.Fonts.body)
                                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)

                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.md)
        .openSourcebookCardStyle()
    }
}

// MARK: - Math

struct MathBlockView: View {
    let latex: String
    let caption: String?

    /// Serif sizes tried widest-first; the first whose rows fit the card wins.
    /// Below the smallest step the block scrolls horizontally instead of
    /// clipping a long equation. Children are written out by hand: a `ForEach`
    /// directly inside `ViewThatFits` trips a SwiftUI precondition.
    private static let sizeSteps: [CGFloat] = [17, 15, 13.5, 12]

    private var lines: [[MathNode]] { MathLatexParser.parseLines(latex) }

    /// Fallback arrangement with lines broken at top-level `\quad` gaps —
    /// a two-line equation at a readable size beats a clipped one-liner.
    private var brokenLines: [[MathNode]] {
        lines.flatMap { MathLatexParser.splitAtGaps($0) }
    }

    var body: some View {
        VStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            ViewThatFits(in: .horizontal) {
                MathLinesView(lines: lines, size: Self.sizeSteps[0])
                MathLinesView(lines: lines, size: Self.sizeSteps[1])
                MathLinesView(lines: lines, size: Self.sizeSteps[2])
                MathLinesView(lines: lines, size: Self.sizeSteps[3])
                if brokenLines.count > lines.count {
                    MathLinesView(lines: brokenLines, size: Self.sizeSteps[0])
                    MathLinesView(lines: brokenLines, size: Self.sizeSteps[1])
                    MathLinesView(lines: brokenLines, size: Self.sizeSteps[2])
                    MathLinesView(lines: brokenLines, size: Self.sizeSteps[3])
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    MathLinesView(lines: lines, size: Self.sizeSteps[3])
                }
            }
            .foregroundStyle(OpenSourcebookTheme.Colors.text)
            .frame(maxWidth: .infinity)
            .padding(OpenSourcebookTheme.Spacing.lg)
            .background(OpenSourcebookTheme.Colors.fill)
            .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))

            if let caption {
                Text(caption)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

// MARK: - Mini-LaTeX

/// Parsed LaTeX atoms. Layout happens in `MathNodeView`; sub/superscripts are
/// siblings of their base and nudge themselves off the row's vertical center.
private indirect enum MathNode {
    case text(String)
    /// Horizontal space, in ems relative to the current font size.
    case gap(CGFloat)
    case group([MathNode])
    case fraction([MathNode], [MathNode])
    case radical([MathNode])
    case sup([MathNode])
    case sub([MathNode])
}

/// A display-math block: one or more parsed lines, centered.
private struct MathLinesView: View {
    let lines: [[MathNode]]
    let size: CGFloat

    var body: some View {
        VStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                MathNodesView(nodes: line, size: size)
            }
        }
    }
}

/// One parsed line as a row of node views, centered on the math axis.
private struct MathNodesView: View {
    let nodes: [MathNode]
    let size: CGFloat

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            ForEach(Array(nodes.enumerated()), id: \.offset) { _, node in
                MathNodeView(node: node, size: size)
            }
        }
    }
}

private struct MathNodeView: View {
    let node: MathNode
    let size: CGFloat

    @ViewBuilder var body: some View {
        switch node {
        case .text(let string):
            Text(string)
                .font(.system(size: size, design: .serif))
                // Never wrap mid-equation: rows must report their true width
                // so `ViewThatFits` picks a smaller size instead.
                .fixedSize(horizontal: true, vertical: false)
        case .gap(let ems):
            Color.clear
                .frame(width: size * ems, height: 1)
        case .group(let children):
            MathNodesView(nodes: children, size: size)
        case .fraction(let numerator, let denominator):
            VStack(spacing: 2) {
                MathNodesView(nodes: numerator, size: size * 0.82)
                Rectangle()
                    .fill(OpenSourcebookTheme.Colors.text)
                    .frame(height: 1)
                MathNodesView(nodes: denominator, size: size * 0.82)
            }
        case .radical(let content):
            HStack(alignment: .center, spacing: 1) {
                Text("√")
                    .font(.system(size: size * 1.2, design: .serif))
                MathNodesView(nodes: content, size: size * 0.95)
                    .padding(.top, 2)
                    .overlay(alignment: .top) {
                        Rectangle()
                            .fill(OpenSourcebookTheme.Colors.text)
                            .frame(height: 1)
                    }
            }
        case .sup(let content):
            MathNodesView(nodes: content, size: size * 0.68)
                .alignmentGuide(VerticalAlignment.center) { dimensions in
                    dimensions[VerticalAlignment.center] + size * 0.34
                }
        case .sub(let content):
            MathNodesView(nodes: content, size: size * 0.68)
                .alignmentGuide(VerticalAlignment.center) { dimensions in
                    dimensions[VerticalAlignment.center] - size * 0.30
                }
        }
    }
}

/// Recursive-descent parser for the LaTeX subset the engine emits: fractions,
/// radicals, sub/superscripts, `\text`, sized delimiters, spacing commands and
/// the Greek/operator symbol table. Unknown commands render as their name
/// without the backslash — raw markup never reaches the screen.
private struct MathLatexParser {
    private let source: String
    private var index: String.Index

    init(_ source: String) {
        self.source = source
        self.index = source.startIndex
    }

    /// Splits display math into lines (`\\` or newlines), then parses each.
    static func parseLines(_ latex: String) -> [[MathNode]] {
        latex
            .components(separatedBy: "\\\\")
            .flatMap { $0.components(separatedBy: .newlines) }
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map { line in
                var parser = MathLatexParser(line)
                return parser.parseExpression(inGroup: false)
            }
            .filter { !$0.isEmpty }
    }

    /// Splits a parsed line at top-level `\quad`-class gaps — the fallback
    /// line breaking for equations too wide for any size step.
    static func splitAtGaps(_ line: [MathNode]) -> [[MathNode]] {
        var parts: [[MathNode]] = [[]]
        for node in line {
            if case .gap(let ems) = node, ems >= 1 {
                parts.append([])
            } else {
                parts[parts.count - 1].append(node)
            }
        }
        return parts.filter { !$0.isEmpty }
    }

    private var isAtEnd: Bool { index >= source.endIndex }

    @discardableResult
    private mutating func advance() -> Character {
        let character = source[index]
        index = source.index(after: index)
        return character
    }

    private mutating func skipSpaces() {
        while !isAtEnd && source[index] == " " { advance() }
    }

    /// A run of nodes. Inside a group this stops at (and consumes) the closing
    /// brace; at the top level a stray `}` is skipped.
    private mutating func parseExpression(inGroup: Bool) -> [MathNode] {
        var nodes: [MathNode] = []
        var run = ""
        func flush() {
            guard !run.isEmpty else { return }
            nodes.append(.text(run))
            run = ""
        }

        while !isAtEnd {
            let character = source[index]
            switch character {
            case "}":
                flush()
                advance()
                if inGroup { return nodes }
            case "{":
                flush()
                advance()
                nodes.append(.group(parseExpression(inGroup: true)))
            case "\\":
                flush()
                advance()
                nodes.append(contentsOf: parseCommand())
            case "_", "^":
                flush()
                advance()
                let argument = parseArgument()
                nodes.append(character == "_" ? .sub(argument) : .sup(argument))
            case " ", "\t":
                // Source spaces collapse to one and survive command boundaries —
                // engine math mixes prose ("Attention(Q, K, V) = …").
                if run.last != " " { run.append(" ") }
                advance()
            default:
                run.append(character)
                advance()
            }
        }
        flush()
        return nodes
    }

    /// One argument: a braced group, a single command, or a single character.
    private mutating func parseArgument() -> [MathNode] {
        skipSpaces()
        guard !isAtEnd else { return [] }
        let character = source[index]
        if character == "{" {
            advance()
            return parseExpression(inGroup: true)
        }
        if character == "\\" {
            advance()
            return parseCommand()
        }
        if character == "_" || character == "^" { return [] } // degenerate; main loop re-reads it
        return [.text(String(advance()))]
    }

    /// Parses the command whose backslash was just consumed.
    private mutating func parseCommand() -> [MathNode] {
        guard !isAtEnd else { return [] }
        guard source[index].isLetter else {
            // Symbol commands are one character: \, \; \: \  \! \% \$ \{ …
            let symbol = advance()
            switch symbol {
            case ",", ";", ":", " ": return [.gap(0.25)]
            case "!", "\\": return []
            default: return [.text(String(symbol))]
            }
        }

        var name = ""
        while !isAtEnd && source[index].isLetter { name.append(advance()) }

        switch name {
        case "frac", "dfrac", "tfrac":
            let numerator = parseArgument()
            let denominator = parseArgument()
            return [.fraction(numerator, denominator)]
        case "sqrt":
            skipSpaces()
            if !isAtEnd && source[index] == "[" {
                // Root index (\sqrt[3]{x}) — parsed but not rendered.
                var depth = 0
                while !isAtEnd {
                    let character = advance()
                    if character == "[" { depth += 1 }
                    if character == "]" {
                        depth -= 1
                        if depth == 0 { break }
                    }
                }
            }
            return [.radical(parseArgument())]
        case "text", "textbf", "textit", "textrm", "textnormal", "mathrm", "mathbf", "mathit", "mathsf", "operatorname", "mbox":
            return [.text(parseRawGroup())]
        case "left", "right", "middle",
             "big", "Big", "bigg", "Bigg",
             "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr":
            return parseDelimiter()
        case "quad":
            return [.gap(1)]
        case "qquad":
            return [.gap(2)]
        default:
            if let symbol = Self.symbols[name] { return [.text(symbol)] }
            if Self.functionNames.contains(name) { return [.text(name)] }
            return [.text(name)]
        }
    }

    /// Braced content taken literally (for `\text` & friends): no command
    /// parsing, braces matched by depth, `\}`-style escapes unescaped.
    private mutating func parseRawGroup() -> String {
        skipSpaces()
        guard !isAtEnd, source[index] == "{" else {
            guard !isAtEnd else { return "" }
            return String(advance())
        }
        advance() // consume {
        var depth = 1
        var text = ""
        while !isAtEnd {
            let character = advance()
            switch character {
            case "{":
                depth += 1
                text.append(character)
            case "}":
                depth -= 1
                if depth == 0 { return text }
                text.append(character)
            case "\\" where !isAtEnd && !source[index].isLetter:
                text.append(advance())
            default:
                text.append(character)
            }
        }
        return text
    }

    /// `\left( \right] \big|` … — the delimiter renders as its plain glyph; a
    /// `.` renders nothing.
    private mutating func parseDelimiter() -> [MathNode] {
        skipSpaces()
        guard !isAtEnd else { return [] }
        if source[index] == "\\" {
            advance()
            var name = ""
            while !isAtEnd && source[index].isLetter { name.append(advance()) }
            if name.isEmpty {
                guard !isAtEnd else { return [] }
                let symbol = advance()
                return symbol == "|" ? [.text("‖")] : [.text(String(symbol))]
            }
            switch name {
            case "langle": return [.text("⟨")]
            case "rangle": return [.text("⟩")]
            case "lbrace": return [.text("{")]
            case "rbrace": return [.text("}")]
            case "lvert", "rvert", "vert": return [.text("|")]
            case "Vert": return [.text("‖")]
            case "lfloor": return [.text("⌊")]
            case "rfloor": return [.text("⌋")]
            case "lceil": return [.text("⌈")]
            case "rceil": return [.text("⌉")]
            default: return [.text(Self.symbols[name] ?? name)]
            }
        }
        let character = advance()
        return character == "." ? [] : [.text(String(character))]
    }

    /// Greek letters, operators, relations and arrows — the v1 substitution
    /// table, now keyed by command name for the parser.
    private static let symbols: [String: String] = [
        "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
        "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "iota": "ι",
        "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ",
        "pi": "π", "rho": "ρ", "sigma": "σ", "tau": "τ", "phi": "φ",
        "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
        "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ",
        "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
        "pm": "±", "mp": "∓", "times": "×", "cdot": "·", "div": "÷",
        "neq": "≠", "approx": "≈", "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥",
        "ll": "≪", "gg": "≫", "sim": "∼", "simeq": "≃", "equiv": "≡", "propto": "∝",
        "Rightarrow": "⇒", "rightarrow": "→", "to": "→",
        "leftarrow": "←", "Leftarrow": "⇐", "mapsto": "↦",
        "sum": "∑", "prod": "∏", "int": "∫", "oint": "∮",
        "infty": "∞", "partial": "∂", "nabla": "∇",
        "in": "∈", "notin": "∉", "subset": "⊂", "subseteq": "⊆",
        "supset": "⊃", "supseteq": "⊇", "cup": "∪", "cap": "∩",
        "setminus": "∖", "emptyset": "∅", "forall": "∀", "exists": "∃",
        "neg": "¬", "land": "∧", "lor": "∨", "circ": "∘", "bullet": "•",
        "star": "⋆", "dagger": "†", "prime": "′", "oplus": "⊕", "otimes": "⊗",
        "perp": "⊥", "parallel": "∥", "angle": "∠", "triangle": "△",
        "therefore": "∴", "because": "∵", "ldots": "…", "dots": "…",
        "cdots": "⋯", "vdots": "⋮", "hbar": "ħ", "ell": "ℓ",
        "Re": "ℜ", "Im": "ℑ", "aleph": "ℵ",
    ]

    /// Commands that typeset as their own upright name (`\sin` → "sin").
    private static let functionNames: Set<String> = [
        "sin", "cos", "tan", "cot", "sec", "csc",
        "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
        "log", "ln", "lg", "exp", "min", "max", "arg",
        "lim", "limsup", "liminf", "sup", "inf",
        "det", "dim", "ker", "deg", "gcd", "hom", "Pr", "softmax",
    ]
}
