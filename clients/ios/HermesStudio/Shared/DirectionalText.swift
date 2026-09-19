import SwiftUI

/// Content text with per-string direction (web `ContentText` / `dir="auto"`):
/// the first strong character decides, the text aligns to its own start,
/// and the surrounding layout direction is never changed. Stored text is
/// never rewritten and no bidi control characters are injected.
struct DirectionalText: View {
    let text: String
    var font: Font = CoreHubTokens.Typography.bodyFont
    var color: Color = CoreHubTokens.Palette.textPrimary
    var lineLimit: Int? = 1

    var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(color)
            .lineLimit(lineLimit)
            .frame(maxWidth: .infinity, alignment: .leading)
            // Last in the chain on purpose: the frame above resolves
            // `.leading` in the direction this modifier installs, so an
            // Arabic title ends at the physical right edge of an English app.
            .contentDirection(of: text)
    }
}

/// Code, paths and model ids are always left-to-right.
struct TechnicalText: View {
    let text: String
    var font: Font = CoreHubTokens.Typography.mono(CoreHubTokens.Typography.meta)
    var color: Color = CoreHubTokens.Palette.textMuted

    var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(color)
            .lineLimit(1)
            .truncationMode(.middle)
            .technicalDirection()
    }
}
