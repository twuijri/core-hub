// The share extension: text or a link shared from another app waits in the App Group for Core
// Hub, which opens a new chat with it. The extension never talks to the hub itself: it holds no
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
        for item in (extensionContext?.inputItems as? [NSExtensionItem]) ?? [] {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    pieces.append(url.absoluteString)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    pieces.append(text)
                }
            }
            if pieces.isEmpty, let text = item.attributedContentText?.string { pieces.append(text) }
        }
        let draft = ShareInbox.compose(pieces)
        if draft.isEmpty {
            label.text = l10n("share.nothing")
        } else {
            ShareInbox.put(draft, in: ShareInbox.defaults())
            label.text = l10n("share.saved")
        }
    }
}
