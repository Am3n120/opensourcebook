import Foundation
import SwiftUI

/// Tiny inline-markdown parser for `.text` blocks.
/// Supports **bold**, *italic*, `code`, [label](https://url) links
/// (rendered by SwiftUI `Text`) and $inline math$ (markers stripped, content
/// rendered plainly — a raw `$` never reaches the screen).
/// Not recursive; unmatched markers render literally.
enum InlineMarkdown {

    static func parse(_ source: String) -> AttributedString {
        var result = AttributedString()
        var rest = Substring(source)

        while !rest.isEmpty {
            if rest.hasPrefix("**"), let close = rest.dropFirst(2).range(of: "**") {
                var segment = AttributedString(rest.dropFirst(2)[..<close.lowerBound])
                segment.inlinePresentationIntent = .stronglyEmphasized
                result.append(segment)
                rest = rest[close.upperBound...]
            } else if rest.hasPrefix("*"), let close = rest.dropFirst().range(of: "*") {
                var segment = AttributedString(rest.dropFirst()[..<close.lowerBound])
                segment.inlinePresentationIntent = .emphasized
                result.append(segment)
                rest = rest[close.upperBound...]
            } else if rest.hasPrefix("`"), let close = rest.dropFirst().range(of: "`") {
                var segment = AttributedString(rest.dropFirst()[..<close.lowerBound])
                segment.inlinePresentationIntent = .code
                result.append(segment)
                rest = rest[close.upperBound...]
            } else if rest.hasPrefix("$"), let close = rest.dropFirst().range(of: "$") {
                let inner = rest.dropFirst()[..<close.lowerBound]
                if let first = inner.first, let last = inner.last,
                   !first.isWhitespace, !last.isWhitespace {
                    // Math span: drop the markers, render the content as-is.
                    result.append(AttributedString(inner))
                    rest = rest[close.upperBound...]
                } else {
                    // Currency-style pair ("$5 and $10"): not math — keep the dollar.
                    result.append(AttributedString(rest.prefix(1)))
                    rest = rest.dropFirst()
                }
            } else if rest.hasPrefix("["),
                      let labelClose = rest.range(of: "]("),
                      let urlClose = rest[labelClose.upperBound...].range(of: ")"),
                      let url = URL(string: String(rest[labelClose.upperBound..<urlClose.lowerBound])) {
                // SwiftUI `Text` opens `.link` runs via the environment's `openURL`.
                var segment = AttributedString(rest.dropFirst()[..<labelClose.lowerBound])
                segment.link = url
                segment.foregroundColor = OpenSourcebookTheme.Colors.primary
                result.append(segment)
                rest = rest[urlClose.upperBound...]
            } else {
                // Plain run up to the next marker (or the marker itself if unmatched).
                let next = rest.firstIndex(where: { $0 == "*" || $0 == "`" || $0 == "[" || $0 == "$" }) ?? rest.endIndex
                if next == rest.startIndex {
                    result.append(AttributedString(rest[...rest.startIndex]))
                    rest = rest.dropFirst()
                } else {
                    result.append(AttributedString(rest[..<next]))
                    rest = rest[next...]
                }
            }
        }

        return result
    }
}
