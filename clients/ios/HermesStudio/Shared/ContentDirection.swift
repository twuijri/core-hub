import SwiftUI

/// Per-string text direction: the iOS half of `docs/CONTENT-DIRECTION.md`.
///
/// The interface language is not the content language. The owner writes
/// Arabic inside an English app and picks English options inside an Arabic
/// one, so direction is resolved from the text itself using the browser's
/// `dir="auto"` rule — the **first strong** character and nothing else.
/// Digits, punctuation, emoji, combining marks and invisible formatting
/// characters carry no direction and are skipped ("the number and the
/// punctuation mark are not evidence of the text's direction"). A string with
/// no strong character at all keeps the surrounding interface direction,
/// which is what `dir="auto"` does on the web. Stored text is never
/// rewritten and no bidi control characters are injected.
enum ContentDirection {
    /// Direction for `text`, falling back to `interface` when the string
    /// holds no strong character (an empty field, `2026-09-19`, `…`, an emoji).
    static func resolve(_ text: String, interface: LayoutDirection) -> LayoutDirection {
        firstStrong(text) ?? interface
    }

    /// The first strongly-directional character's direction, or `nil` when
    /// the string has none. This is the whole algorithm; there is no
    /// "dominant language" guess anywhere.
    static func firstStrong(_ text: String) -> LayoutDirection? {
        for scalar in text.unicodeScalars {
            guard isLetter(scalar) else { continue }
            return isRightToLeftLetter(scalar) ? .rightToLeft : .leftToRight
        }
        return nil
    }

    /// Only letters count as strong.
    ///
    /// `CharacterSet.letters` cannot be used for this: Foundation defines it
    /// as the Unicode general categories L\* **and M\***, so an Arabic
    /// diacritic, a Hebrew niqqud point or any other combining mark would be
    /// read as a strong character. The general category is checked directly
    /// instead, which also drops digits (`١٢٣` is AN, `123` is EN), currency
    /// signs, emoji and format characters such as a leading byte-order mark.
    private static func isLetter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter:
            return true
        default:
            return false
        }
    }

    /// The right-to-left letter blocks. Digits and marks inside them were
    /// already dropped by `isLetter`, so the ranges stay whole and readable.
    private static func isRightToLeftLetter(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x0590...0x05FF,   // Hebrew
             0x0600...0x06FF,   // Arabic
             0x0700...0x074F,   // Syriac
             0x0750...0x077F,   // Arabic Supplement
             0x0780...0x07BF,   // Thaana
             0x07C0...0x07FF,   // NKo
             0x0800...0x083F,   // Samaritan
             0x0840...0x085F,   // Mandaic
             0x0860...0x08FF,   // Syriac Supplement, Arabic Extended-A and -B
             0xFB1D...0xFDFF,   // Hebrew and Arabic presentation forms A
             0xFE70...0xFEFF:   // Arabic presentation forms B
            return true
        default:
            return false
        }
    }
}

/// Applies the content's own direction to a text field or a text view.
///
/// This is the iOS counterpart of the web's `contentInputProps`: the field
/// follows what is being typed, not the interface language, and it aligns to
/// its own start. The modifier must be the **last** one on the field, because
/// `frame(alignment:)` and directional padding read the layout direction of
/// their own parent — wrapping them is what makes `.leading` mean the
/// physical right edge for Arabic.
struct ContentDirectionModifier: ViewModifier {
    let text: String
    /// The direction the surrounding interface is using, used only when the
    /// text itself has nothing to say (an empty composer).
    @Environment(\.layoutDirection) private var interface

    func body(content: Content) -> some View {
        content
            .multilineTextAlignment(.leading)
            .environment(\.layoutDirection, ContentDirection.resolve(text, interface: interface))
    }
}

extension View {
    /// Human text: direction per string, interface direction while empty.
    /// Put it last in the modifier chain. See `docs/CONTENT-DIRECTION.md`.
    func contentDirection(of text: String) -> some View {
        modifier(ContentDirectionModifier(text: text))
    }

    /// Code, paths, model ids, cron expressions and invite codes: always
    /// left-to-right, whatever the interface is doing.
    func technicalDirection() -> some View {
        environment(\.layoutDirection, .leftToRight)
    }
}
