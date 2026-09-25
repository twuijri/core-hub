// UI direction follows the UI language; each piece of content decides its own (DESIGN.md
// §Language) — the phone's version of `dir="auto"`: the first strong character wins.
import SwiftUI

enum ContentDirection {
    /// Right-to-left when the first letter with a strong direction is Arabic, Hebrew or
    /// another RTL script; left-to-right when it is Latin or another LTR script; `nil` when
    /// the text has no strong character (numbers, punctuation, emoji).
    static func of(_ text: String) -> LayoutDirection? {
        for scalar in text.unicodeScalars {
            let v = scalar.value
            if isRTL(v) { return .rightToLeft }
            if scalar.properties.isAlphabetic { return .leftToRight }
        }
        return nil
    }

    static func isRTL(_ v: UInt32) -> Bool {
        (0x0590...0x08FF).contains(v)       // Hebrew, Arabic, Syriac, Thaana, NKo, Arabic ext.
            || (0xFB1D...0xFDFF).contains(v) // Hebrew and Arabic presentation forms A
            || (0xFE70...0xFEFF).contains(v) // Arabic presentation forms B
            || (0x10800...0x10FFF).contains(v)
            || (0x1E800...0x1EFFF).contains(v)
    }
}

private struct ContentDirectionModifier: ViewModifier {
    @Environment(\.layoutDirection) private var inherited
    let text: String
    let fill: Bool

    func body(content: Content) -> some View {
        let direction = ContentDirection.of(text) ?? inherited
        content
            .multilineTextAlignment(.leading)
            .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
            .environment(\.layoutDirection, direction)
    }
}

extension View {
    /// Lays the view out in the direction of `text`'s first strong character.
    /// `fill: false` keeps the view as wide as its text (a person's bubble).
    func contentDirection(of text: String, fill: Bool = true) -> some View {
        modifier(ContentDirectionModifier(text: text, fill: fill))
    }
}
