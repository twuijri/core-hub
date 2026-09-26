// The share extension: text, a link, pictures or files shared from another app wait in the App
// Group for Core Hub, which opens a new chat with them (the files as attachments). The extension never talks to the hub itself: it holds no
// credentials, so a shared piece cannot go anywhere the person did not open.
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let l10n = L10n(.preferred)
    private let label = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        view.semanticContentAttribute = l10n.language.isRTL ? .forceRightToLeft : .forceLeftToRight
        label.numberOfLines = 0
        label.textAlignment = .natural
        label.font = .preferredFont(forTextStyle: .body)
        label.text = l10n("common.loading")
        let done = UIButton(type: .system, primaryAction: UIAction(title: l10n("share.done")) { [weak self] _ in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        let stack = UIStackView(arrangedSubviews: [label, done])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        Task { await collect() }
    }

    private func collect() async {
        var pieces: [String] = []
        var files = 0
        let defaults = ShareInbox.defaults(), folder = ShareInbox.folder()
        for item in (extensionContext?.inputItems as? [NSExtensionItem]) ?? [] {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) as? URL {
                    let scoped = url.startAccessingSecurityScopedResource()
                    if ShareInbox.putFile(url, in: defaults, folder: folder) != nil { files += 1 }
                    if scoped { url.stopAccessingSecurityScopedResource() }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                          let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    pieces.append(url.absoluteString)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    pieces.append(text)
                } else if let type = Self.fileType(of: provider), await copy(provider, type: type, defaults: defaults, folder: folder) {
                    files += 1
                }
            }
            if pieces.isEmpty, files == 0, let text = item.attributedContentText?.string { pieces.append(text) }
        }
        let draft = ShareInbox.compose(pieces)
        if !draft.isEmpty { ShareInbox.put(draft, in: defaults) }
        label.text = draft.isEmpty && files == 0 ? l10n("share.nothing") : l10n("share.saved")
    }

    /// A picture, a video, a sound, a PDF or any other file the provider holds.
    private static func fileType(of provider: NSItemProvider) -> String? {
        for type in [UTType.image, .movie, .audio, .pdf, .data] where provider.hasItemConformingToTypeIdentifier(type.identifier) {
            return provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: type) ?? false } ?? type.identifier
        }
        return nil
    }

    /// The provider's file, copied into the App Group before the system deletes its temporary copy.
    private func copy(_ provider: NSItemProvider, type: String, defaults: UserDefaults?, folder: URL?) async -> Bool {
        await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                guard let url else { return continuation.resume(returning: false) }
                let name = provider.suggestedName.map { name in
                    (name as NSString).pathExtension.isEmpty ? name + "." + url.pathExtension : name
                } ?? url.lastPathComponent
                continuation.resume(returning: ShareInbox.putFile(url, name: name, in: defaults, folder: folder) != nil)
            }
        }
    }
}
