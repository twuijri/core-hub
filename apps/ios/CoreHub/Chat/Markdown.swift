// Markdown for replies. SwiftUI's `Text` renders inline Markdown (emphasis, code, links) but
// not blocks, so this splits a reply into blocks — paragraphs, headings, lists, quotes, fenced
// code, rules — and each block renders its inline Markdown itself. The split is pure and tested
// (MarkdownTests); a half-streamed reply (an open fence) still renders.
import SwiftUI
import UIKit

enum MarkdownBlock: Equatable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bullet(items: [String])
    case numbered(start: Int, items: [String])
    case quote(String)
    case code(language: String?, code: String)
    case rule
}

enum MarkdownParser {
    static func blocks(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var numbered: [String] = []
        var numberedStart = 1
        var quote: [String] = []
        var fence: (marker: String, language: String?, lines: [String])?

        func flush() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
            if !bullets.isEmpty {
                blocks.append(.bullet(items: bullets))
                bullets = []
            }
            if !numbered.isEmpty {
                blocks.append(.numbered(start: numberedStart, items: numbered))
                numbered = []
            }
            if !quote.isEmpty {
                blocks.append(.quote(quote.joined(separator: "\n")))
                quote = []
            }
        }

        for rawLine in source.components(separatedBy: "\n") {
            let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if let open = fence {
                let markerChar = open.marker.first ?? "`"
                if trimmed.count >= 3 && trimmed.allSatisfy({ $0 == markerChar }) {
                    blocks.append(.code(language: open.language, code: open.lines.joined(separator: "\n")))
                    fence = nil
                } else {
                    fence?.lines.append(line)
                }
                continue
            }

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let marker = String(trimmed.prefix(3))
                let info = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                fence = (marker, info.isEmpty ? nil : String(info.split(separator: " ").first ?? ""), [])
                continue
            }

            if trimmed.isEmpty {
                flush()
                continue
            }

            if let heading = headingLevel(trimmed) {
                flush()
                blocks.append(.heading(level: heading.level, text: heading.text))
                continue
            }

            if isRule(trimmed) {
                flush()
                blocks.append(.rule)
                continue
            }

            if trimmed.hasPrefix(">") {
                if quote.isEmpty { flush() }
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }

            if let item = bulletItem(trimmed) {
                if bullets.isEmpty { flush() }
                bullets.append(item)
                continue
            }

            if let item = numberedItem(trimmed) {
                if numbered.isEmpty {
                    flush()
                    numberedStart = item.number
                }
                numbered.append(item.text)
                continue
            }

            // A continuation line of a list item stays with it.
            if !bullets.isEmpty, line.hasPrefix("  ") {
                bullets[bullets.count - 1] += " " + trimmed
                continue
            }
            if !numbered.isEmpty, line.hasPrefix("  ") {
                numbered[numbered.count - 1] += " " + trimmed
                continue
            }
            if !bullets.isEmpty || !numbered.isEmpty || !quote.isEmpty { flush() }
            paragraph.append(line)
        }
        if let open = fence {
            // Still streaming: show what has arrived.
            blocks.append(.code(language: open.language, code: open.lines.joined(separator: "\n")))
        }
        flush()
        return blocks
    }

    static func headingLevel(_ line: String) -> (level: Int, text: String)? {
        var level = 0
        for c in line {
            if c == "#" { level += 1 } else { break }
        }
        guard (1...6).contains(level) else { return nil }
        let rest = line.dropFirst(level)
        guard rest.first == " " else { return nil }
        return (level, rest.trimmingCharacters(in: .whitespaces))
    }

    static func isRule(_ line: String) -> Bool {
        let compact = line.replacingOccurrences(of: " ", with: "")
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    static func bulletItem(_ line: String) -> String? {
        for marker in ["- ", "* ", "+ ", "• "] where line.hasPrefix(marker) {
            return String(line.dropFirst(marker.count))
        }
        return nil
    }

    static func numberedItem(_ line: String) -> (number: Int, text: String)? {
        var digits = ""
        var rest = Substring(line)
        while let c = rest.first, c.isASCII, c.isNumber, digits.count < 9 {
            digits.append(c)
            rest = rest.dropFirst()
        }
        guard !digits.isEmpty, let number = Int(digits),
              let dot = rest.first, dot == "." || dot == ")" else { return nil }
        rest = rest.dropFirst()
        guard rest.first == " " else { return nil }
        return (number, rest.trimmingCharacters(in: .whitespaces))
    }

    /// Inline Markdown as an attributed string; plain text when it does not parse.
    static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

/// A reply rendered block by block. Each block decides its own direction from its content.
struct MarkdownView: View {
    let text: String
    var foreground: Color = Tone.agentBubbleText

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            ForEach(Array(MarkdownParser.blocks(text).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .foregroundStyle(foreground)
        .tint(Tone.link)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            inlineText(text)
        case .heading(let level, let text):
            inlineText(text, size: level <= 1 ? FontSize.sizeXl : level == 2 ? FontSize.sizeLg : FontSize.sizeMd, weight: .semibold)
        case .bullet(let items):
            VStack(alignment: .leading, spacing: Space.s1) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    listRow(marker: "•", text: item)
                }
            }
        case .numbered(let start, let items):
            VStack(alignment: .leading, spacing: Space.s1) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    listRow(marker: "\(start + index).", text: item)
                }
            }
        case .quote(let text):
            HStack(alignment: .top, spacing: Space.s2) {
                Rectangle().fill(Tone.borderStrong).frame(width: 3)
                inlineText(text).foregroundStyle(Tone.textMuted)
            }
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
        case .rule:
            Divider().overlay(Tone.border)
        }
    }

    private func inlineText(_ text: String, size: CGFloat = FontSize.sizeMd, weight: Font.Weight = .regular) -> some View {
        Text(MarkdownParser.inline(text))
            .font(.system(size: size, weight: weight))
            .lineSpacing(4)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .contentDirection(of: text)
    }

    private func listRow(marker: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
            Text(marker).foregroundStyle(Tone.textMuted)
            inlineText(text)
        }
        .contentDirection(of: text)
    }
}

struct CodeBlockView: View {
    let language: String?
    let code: String
    @Environment(\.l10n) private var l10n

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "")
                    .font(.system(size: FontSize.sizeXs, design: .monospaced))
                    .foregroundStyle(Tone.textMuted)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                } label: {
                    LucideIcon(.copy, size: 14)
                        .hitSlop(12)
                }
                .accessibilityLabel(l10n("common.copy"))
            }
            .padding(.horizontal, Space.s3)
            .padding(.vertical, Space.s1)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: FontSize.sizeSm, design: .monospaced))
                    .foregroundStyle(Tone.codeText)
                    .textSelection(.enabled)
                    .padding(Space.s3)
            }
        }
        .background(Tone.codeBg, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
        // Code reads left to right in every locale.
        .environment(\.layoutDirection, .leftToRight)
    }
}
