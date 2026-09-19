import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// QR code rendered on the device with `CIQRCodeGenerator` (no network).
enum QRCodeRenderer {
    static func image(for text: String, scale: CGFloat = 12) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

/// The invite link of a room as a QR code with the link and code below it.
struct RoomInviteQRView: View {
    let link: URL
    let inviteCode: String

    var body: some View {
        VStack(spacing: 12) {
            if let image = QRCodeRenderer.image(for: link.absoluteString) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 240)
                    .padding(12)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.card, style: .continuous))
                    .accessibilityLabel("Invite QR code")
            } else {
                Text("The QR code could not be generated.").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.error)
            }
            TechnicalText(text: inviteCode, font: CoreHubTokens.Typography.mono(18, weight: .semibold), color: CoreHubTokens.Palette.textPrimary)
            TechnicalText(text: link.absoluteString, font: CoreHubTokens.Typography.mono(CoreHubTokens.Typography.meta), color: CoreHubTokens.Palette.textMuted)
            HStack(spacing: 10) {
                Button { UIPasteboard.general.string = link.absoluteString } label: { Label("Copy link", systemImage: "doc.on.doc") }
                    .buttonStyle(CoreHubPillButtonStyle())
                ShareLink(item: link) { Label("Share", systemImage: "square.and.arrow.up") }
                    .buttonStyle(CoreHubPillButtonStyle(prominent: true))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }
}
