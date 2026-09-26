// Files in the composer (owner, 2026-09-25): the «+» button offers a photo from the library,
// the camera, or a file. Each one is uploaded to the hub as soon as it is picked
// (`sessions.uploadAttachment`, or the resumable `sessions.startUpload` flow above 25 MB, as the
// web's composer does), shows as a chip with a preview and a remove button, and goes with the next
// message as an image or file block.
//
// Photos go «Compressed» or at «Original quality», as in Telegram (owner, 2026-09-26: «خله خيارين
// مثل التيليقرام مع ضغط ولا بدون»): the choice sits in the «+» menu and is remembered.
import AVKit
import CoreHubClient
import Foundation
import Observation
import PhotosUI
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The words and files of one message on their way to the hub.
struct OutgoingMessage: Equatable {
    var text: String
    var attachments: [Attachment] = []
    /// Photos sent at original quality go as files (as Telegram's «send as file»), whatever
    /// their kind: the agent gets the untouched bytes.
    var asFiles: Set<String> = []

    var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty }

    /// The blocks `sessions.createRun` takes: the text, then one block per file (web: `blocksFor`).
    var blocks: [ContentBlock] {
        var blocks: [ContentBlock] = []
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { blocks.append(.typeTextBlock(TextBlock(type: .text, text: trimmed))) }
        for file in attachments {
            switch asFiles.contains(file.id) ? .file : file.kind {
            case .image:
                blocks.append(.typeImageBlock(ImageBlock(
                    attachmentId: file.id, name: file.name, mime: file.mime, sizeBytes: file.sizeBytes, type: .image
                )))
            case .audio:
                blocks.append(.typeAudioBlock(AudioBlock(
                    attachmentId: file.id, name: file.name, mime: file.mime, sizeBytes: file.sizeBytes, type: .audio
                )))
            case .video, .file:
                blocks.append(.typeFileBlock(FileBlock(
                    attachmentId: file.id, name: file.name, mime: file.mime, sizeBytes: file.sizeBytes, type: .file
                )))
            }
        }
        return blocks
    }
}

enum AttachmentRules {
    /// `sessions.uploadAttachment` takes a file in one request up to 25 MB; above it the
    /// resumable flow (`sessions.startUpload`).
    static let maxOneShotBytes = 25 * 1024 * 1024
    /// The hub's largest attachment: the contract's `UploadStart.size_bytes` maximum (50 MB; the
    /// contract offers no call that reports it, and `AttachmentLimitTests` holds this to it). A
    /// `413` from the hub names its own figure in `details.max_bytes`, which wins.
    static let maxBytes = 50 * 1024 * 1024
    /// Photos are made smaller before they leave the phone: the longer side at most this.
    static let photoMaxSide: CGFloat = 2048
    static let photoQuality: CGFloat = 0.8

    /// `size` scaled down (never up) so its longer side is at most `maxSide`.
    static func fitted(_ size: CGSize, maxSide: CGFloat = photoMaxSide) -> CGSize {
        let longer = max(size.width, size.height)
        guard longer > maxSide, longer > 0 else { return size }
        let scale = maxSide / longer
        return CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    }

    /// A photo as the JPEG the hub receives: at most `photoMaxSide` on its longer side.
    static func jpeg(_ image: UIImage) -> Data? {
        let target = fitted(image.size)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let drawn = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return drawn.jpegData(compressionQuality: photoQuality)
    }

    /// A readable size: «3.4 MB».
    static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

/// The files waiting in the composer. Uploads start when a file is picked; sending takes the
/// ones that finished.
@MainActor
@Observable
final class AttachmentTray {
    struct Item: Identifiable, Equatable {
        enum State: Equatable {
            case uploading
            case ready(Attachment)
            case failed(String)
        }

        let id = UUID()
        let name: String
        let isImage: Bool
        let preview: UIImage?
        var state: State
        /// A photo at original quality: sent as a file block.
        var asFile = false
    }

    private(set) var items: [Item] = []

    /// Uploads one local file into `profile`; the hub's attachment back.
    typealias Upload = (_ file: URL, _ profile: String) async throws -> Attachment
    /// Deletes an uploaded attachment nothing uses yet (a chip removed before sending).
    typealias Discard = (_ attachment: Attachment) async -> Void

    @ObservationIgnored private let upload: Upload
    @ObservationIgnored private let discard: Discard
    @ObservationIgnored private let describe: (Error) -> String
    @ObservationIgnored private let tooLarge: (Int) -> String
    @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]

    init(upload: @escaping Upload, discard: @escaping Discard, describe: @escaping (Error) -> String,
         tooLarge: @escaping (Int) -> String) {
        self.upload = upload
        self.discard = discard
        self.describe = describe
        self.tooLarge = tooLarge
    }

    /// The tray a composer uses: uploads through the hub in the chat's profile.
    convenience init(app: AppModel) {
        self.init(
            upload: { [weak app] file, profile in
                guard let app else { throw HubFailure.signedOut }
                return try await AttachmentUploader(backend: HubAttachmentBackend(api: app.api)).upload(file, profile: profile)
            },
            discard: { [weak app] attachment in
                guard let app else { return }
                _ = try? await app.api.call {
                    try await SessionsAPI.sessionsDeleteAttachment(xHubProfile: attachment.profile, attachmentId: attachment.id, apiConfiguration: $0)
                }
            },
            describe: { [weak app] error in
                let l10n = app?.l10n ?? L10n(.en)
                let failure = HubFailure(error)
                if failure.status == 413 {
                    return l10n("attachments.too_large", ["size": AttachmentRules.size(failure.maxBytes ?? AttachmentRules.maxBytes)])
                }
                return failure.describe(l10n)
            },
            tooLarge: { [weak app] _ in
                (app?.l10n ?? L10n(.en))("attachments.too_large", ["size": AttachmentRules.size(AttachmentRules.maxBytes)])
            }
        )
    }

    var isEmpty: Bool { items.isEmpty }
    /// Something is still on its way: sending waits for it.
    var uploading: Bool { items.contains { $0.state == .uploading } }
    /// What finished uploading, in the order it was picked.
    var attachments: [Attachment] {
        items.compactMap { if case .ready(let attachment) = $0.state { return attachment } else { return nil } }
    }

    /// The uploaded photos that go as files (original quality).
    var asFiles: Set<String> {
        Set(items.compactMap { item in
            if item.asFile, case .ready(let attachment) = item.state { return attachment.id }
            return nil
        })
    }

    /// The message these files make with `text`.
    func message(_ text: String) -> OutgoingMessage {
        OutgoingMessage(text: text, attachments: attachments, asFiles: asFiles)
    }

    /// A photo from the library or the camera: made smaller, sent as JPEG.
    func addPhoto(_ image: UIImage, profile: String) {
        guard let data = AttachmentRules.jpeg(image) else { return }
        let name = "photo-\(Self.stamp()).jpg"
        let preview = image.preparingThumbnail(of: CGSize(width: 120, height: 120)) ?? image
        add(data: data, name: name, isImage: true, preview: preview, profile: profile)
    }

    /// A photo at original quality: its own bytes, untouched (HEIC, JPEG or PNG at full size,
    /// with its orientation and all its metadata), sent as a file. `type` names its format.
    func addOriginalPhoto(_ data: Data, type: UTType?, profile: String) {
        let ext = type?.preferredFilenameExtension ?? "jpg"
        let name = "photo-\(Self.stamp()).\(ext)"
        let preview = UIImage(data: data)?.preparingThumbnail(of: CGSize(width: 120, height: 120))
        add(data: data, name: name, isImage: true, preview: preview, profile: profile, asFile: true)
    }

    /// A camera photo at original quality: the camera hands over a picture, not a file, so it is
    /// written at full size as JPEG at the top quality, upright (its orientation in EXIF).
    func addOriginalCameraPhoto(_ image: UIImage, profile: String) {
        guard let data = image.jpegData(compressionQuality: 1.0) else { return }
        let name = "photo-\(Self.stamp()).jpg"
        let preview = image.preparingThumbnail(of: CGSize(width: 120, height: 120)) ?? image
        add(data: data, name: name, isImage: true, preview: preview, profile: profile, asFile: true)
    }

    /// A file the person chose (security-scoped): copied, checked against the hub's limit, sent.
    func addFile(_ url: URL, profile: String) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent
        let isImage = UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) ?? false
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if size > AttachmentRules.maxBytes {
            items.append(Item(name: name, isImage: isImage, preview: nil, state: .failed(tooLarge(size))))
            return
        }
        guard let data = try? Data(contentsOf: url) else {
            items.append(Item(name: name, isImage: isImage, preview: nil, state: .failed(describe(CocoaError(.fileReadUnknown)))))
            return
        }
        let preview = isImage ? UIImage(data: data)?.preparingThumbnail(of: CGSize(width: 120, height: 120)) : nil
        add(data: data, name: name, isImage: isImage, preview: preview, profile: profile)
    }

    /// Writes the bytes under their own name (the upload's file name is the attachment's) and uploads.
    func add(data: Data, name: String, isImage: Bool, preview: UIImage?, profile: String, asFile: Bool = false) {
        if data.count > AttachmentRules.maxBytes {
            items.append(Item(name: name, isImage: isImage, preview: preview, state: .failed(tooLarge(data.count)), asFile: asFile))
            return
        }
        let item = Item(name: name, isImage: isImage, preview: preview, state: .uploading, asFile: asFile)
        items.append(item)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("outgoing-\(item.id.uuidString)", isDirectory: true)
        let file = folder.appendingPathComponent(name)
        let upload = upload
        let describe = describe
        tasks[item.id] = Task { [weak self] in
            let result: Item.State
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try data.write(to: file)
                result = .ready(try await upload(file, profile))
            } catch is CancellationError {
                return
            } catch {
                result = .failed(describe(error))
            }
            try? FileManager.default.removeItem(at: folder)
            guard let self, !Task.isCancelled else { return }
            self.tasks[item.id] = nil
            if let index = self.items.firstIndex(where: { $0.id == item.id }) {
                self.items[index].state = result
            } else if case .ready(let attachment) = result {
                // Removed while it was uploading: nothing will use it.
                await self.discard(attachment)
            }
        }
    }

    /// The chip's ×: the file does not go, and an uploaded one is deleted on the hub.
    func remove(_ id: UUID) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        let item = items.remove(at: index)
        if case .ready(let attachment) = item.state {
            let discard = discard
            Task { await discard(attachment) }
        }
    }

    /// After sending: the files now belong to the message.
    func clear() {
        items.removeAll()
        tasks.removeAll()
    }

    private static func stamp() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: Date())
    }
}

/// The «+» menu: photo library, camera, file. The pickers are the system's own.
struct AttachButton: View {
    let tray: AttachmentTray
    let profile: String
    @Environment(\.l10n) private var l10n
    @Environment(AppModel.self) private var app
    @State private var choosingPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var takingPhoto = false
    @State private var choosingFiles = false

    var body: some View {
        @Bindable var device = app.device
        Menu {
            // Telegram's choice: photos compressed, or at their original quality (remembered).
            Picker(l10n("attachments.photo_quality"), selection: $device.photoQuality) {
                Text(l10n("attachments.compressed")).tag(DeviceSettings.PhotoQuality.compressed)
                Text(l10n("attachments.original")).tag(DeviceSettings.PhotoQuality.original)
            }
            .pickerStyle(.inline)
            .accessibilityIdentifier("composer.photo_quality")
            Button {
                choosingPhotos = true
            } label: {
                Label { Text(l10n("attachments.photo_library")) } icon: { Image(lucide: .image) }
            }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button {
                    takingPhoto = true
                } label: {
                    Label { Text(l10n("attachments.camera")) } icon: { Image(lucide: .camera) }
                }
            }
            Button {
                choosingFiles = true
            } label: {
                Label { Text(l10n("attachments.file")) } icon: { Image(lucide: .fileText) }
            }
        } label: {
            Image(lucide: .plus)
                .resizable()
                .frame(width: 20, height: 20)
                .foregroundStyle(Tone.textMuted)
                .frame(width: Control.heightMd, height: Control.heightMd)
        }
        .accessibilityLabel(l10n("attachments.add"))
        .accessibilityIdentifier("composer.attach")
        .photosPicker(
            isPresented: $choosingPhotos, selection: $photos, maxSelectionCount: 10, matching: .images,
            // `.current`: the library's own file (HEIC stays HEIC), never a transcoded copy.
            preferredItemEncoding: .current
        )
        .onChange(of: photos) { _, picked in
            guard !picked.isEmpty else { return }
            photos = []
            let original = app.device.photoQuality == .original
            for item in picked {
                Task {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { return }
                    if original {
                        let type = item.supportedContentTypes.first { $0.conforms(to: .image) }
                        tray.addOriginalPhoto(data, type: type, profile: profile)
                    } else if let image = UIImage(data: data) {
                        tray.addPhoto(image, profile: profile)
                    }
                }
            }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { image in
                if let image {
                    if app.device.photoQuality == .original {
                        tray.addOriginalCameraPhoto(image, profile: profile)
                    } else {
                        tray.addPhoto(image, profile: profile)
                    }
                }
                takingPhoto = false
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls { tray.addFile(url, profile: profile) }
        }
    }
}

/// The chips above the composer: a preview (or the file's icon), the name, and ×.
struct AttachmentChips: View {
    let tray: AttachmentTray
    @Environment(\.l10n) private var l10n

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.s2) {
                ForEach(tray.items) { item in chip(item) }
            }
            .padding(.horizontal, Space.s1)
        }
        .accessibilityIdentifier("composer.attachments")
    }

    private func chip(_ item: AttachmentTray.Item) -> some View {
        HStack(spacing: Space.s2) {
            ZStack {
                if let preview = item.preview {
                    Image(uiImage: preview)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 36, height: 36)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
                } else {
                    Image(lucide: item.isImage ? .image : .fileText)
                        .resizable()
                        .frame(width: 18, height: 18)
                        .foregroundStyle(Tone.textMuted)
                        .frame(width: 36, height: 36)
                        .background(Tone.surface2, in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
                }
                if item.state == .uploading {
                    ProgressView().controlSize(.small)
                }
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(item.name)
                    .font(.system(size: FontSize.sizeXs))
                    .foregroundStyle(Tone.text)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if case .failed(let message) = item.state {
                    Text(message)
                        .font(.system(size: FontSize.sizeXs))
                        .foregroundStyle(Tone.dangerSoftText)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: 160, alignment: .leading)
            Button {
                tray.remove(item.id)
            } label: {
                Image(lucide: .x)
                    .resizable()
                    .frame(width: 14, height: 14)
                    .foregroundStyle(Tone.textMuted)
                    .frame(width: 28, height: 28)
            }
            .accessibilityLabel(l10n("attachments.remove", ["name": item.name]))
        }
        .padding(Space.s1)
        .background(Tone.surface, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.md, style: .continuous).strokeBorder(Tone.border))
    }
}

/// The system camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
    let done: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(done: done) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (UIImage?) -> Void

        init(done: @escaping (UIImage?) -> Void) { self.done = done }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            done(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { done(nil) }
    }
}

/// The files a message carries, under its text (owner, 2026-09-26: «كل ملف يفتح»). A picture is
/// drawn in place and opens full screen in Quick Look (zoom, and the share sheet to save or send
/// it); any other file is a row with its kind, name and size that opens it: in Quick Look (PDF,
/// text, documents), in the player (audio, video, streamed from a one-hour ticket), or the share
/// sheet for anything else. A download shows its progress and can be cancelled; a failure is one
/// line with a retry. The bytes come with the bearer header (`sessions.downloadAttachment`), never
/// a token in a URL.
struct MessageAttachments: View {
    let content: [ContentBlock]
    /// The chat's profile, which the files belong to.
    var profile: String = ""
    @State private var opener = FileOpener()

    struct File: Identifiable, Equatable {
        let id: Int
        let attachmentID: String
        let name: String
        let isImage: Bool
        var mime: String? = nil
        var size: Int? = nil
        /// Where the hub serves it (the block's `url`), which a link in the reply may name.
        var url: String? = nil

        var hubFile: HubFile { .attachment(id: attachmentID, name: name, mime: mime, size: size) }
    }

    /// The message's files; a picture — sent as an image or as a file (a photo at original
    /// quality) — is drawn, anything else is a row.
    static func files(_ content: [ContentBlock]) -> [File] {
        content.enumerated().compactMap { index, block in
            switch block {
            case .typeImageBlock(let image):
                let name = image.name ?? "image"
                let drawn = FileKinds.openAs(name, image.mime) == .picture || FileKinds.mime(of: name, image.mime) == "application/octet-stream"
                return File(id: index, attachmentID: image.attachmentId, name: name, isImage: drawn, mime: image.mime, size: image.sizeBytes, url: image.url)
            case .typeFileBlock(let file):
                let name = file.name ?? "file"
                return File(id: index, attachmentID: file.attachmentId, name: name, isImage: FileKinds.openAs(name, file.mime) == .picture, mime: file.mime, size: file.sizeBytes, url: file.url)
            case .typeAudioBlock(let audio):
                return File(id: index, attachmentID: audio.attachmentId, name: audio.name ?? "audio", isImage: false, mime: audio.mime, size: audio.sizeBytes, url: audio.url)
            default:
                return nil
            }
        }
    }

    var body: some View {
        let files = Self.files(content)
        if !files.isEmpty {
            VStack(alignment: .leading, spacing: Space.s1) {
                ForEach(files) { file in
                    if file.isImage {
                        PictureAttachment(file: file.hubFile, profile: profile, opener: opener)
                    } else {
                        OpenableFileRow(file: file.hubFile, profile: profile, opener: opener)
                    }
                }
            }
            .fileOpener(opener)
            .accessibilityIdentifier("message.attachments")
        }
    }
}

/// A file opened from a message or a link, for the sheets that show it.
struct OpenedFile: Identifiable {
    let id = UUID()
    let url: URL
}

/// Opens a file of the hub the way its kind opens, fetching it first: the same path for a
/// message's file and for a reply's link to one (`MarkdownView` with `FileLinkOpener`).
@MainActor
@Observable
final class FileOpener {
    /// Shown in Quick Look.
    var preview: URL?
    /// Played from its ticket.
    var playing: OpenedFile?
    /// Handed to the share sheet.
    var sharing: SharedFile?
    /// Why the last link could not be opened, in one sentence.
    var notice: String?
    @ObservationIgnored private var pending: HubFile?

    func open(_ file: HubFile, profile: String, app: AppModel) {
        let downloads = FileDownloads.shared
        if FileKinds.openAs(file) == .media, !downloads.state(file).isReady {
            // Played from a one-hour ticket with byte ranges, so a long recording starts at once.
            Task {
                if let address = try? await downloads.streamAddress(file, profile: profile, app: app) {
                    playing = OpenedFile(url: address)
                } else {
                    fetchThenOpen(file, profile: profile, app: app)
                }
            }
            return
        }
        fetchThenOpen(file, profile: profile, app: app)
    }

    private func fetchThenOpen(_ file: HubFile, profile: String, app: AppModel) {
        if case .ready(let url) = FileDownloads.shared.state(file) {
            show(url, file)
        } else {
            pending = file
            FileDownloads.shared.start(file, profile: profile, app: app)
        }
    }

    /// Called as the downloads change: opens the file the person asked for once it is here.
    func settle(_ states: [String: FileDownloads.State]) {
        guard let want = pending else { return }
        switch states[want.cacheKey] {
        case .ready(let url):
            pending = nil
            show(url, want)
        case .loading:
            break
        default:
            pending = nil
        }
    }

    private func show(_ url: URL, _ file: HubFile) {
        switch FileKinds.openAs(file) {
        case .picture, .viewer, .media:
            // Quick Look draws pictures (zoom, share, save), documents and text, and plays sound
            // and video; what it cannot show goes to the share sheet.
            if QLPreviewController.canPreview(url as NSURL) { preview = url } else { sharing = SharedFile(url: url) }
        case .share:
            sharing = SharedFile(url: url)
        }
    }
}

extension FileDownloads.State {
    var isReady: Bool {
        if case .ready = self { return true }
        return false
    }
}

private struct FileOpenerSheets: ViewModifier {
    @Bindable var opener: FileOpener

    func body(content: Content) -> some View {
        content
            .quickLookPreview($opener.preview)
            .fullScreenCover(item: $opener.playing) { item in MediaPlayerView(url: item.url) }
            .sheet(item: $opener.sharing) { item in ActivitySheet(items: [item.url]) }
            .onChange(of: FileDownloads.shared.states) { _, states in opener.settle(states) }
    }
}

extension View {
    /// Presents what `opener` opens: Quick Look, the player, the share sheet.
    func fileOpener(_ opener: FileOpener) -> some View { modifier(FileOpenerSheets(opener: opener)) }
}

/// A sound or a video from its ticket, full screen, with a close button.
struct MediaPlayerView: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    @Environment(\.l10n) private var l10n
    @State private var player: AVPlayer?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()
            if let player { VideoPlayer(player: player).ignoresSafeArea() }
            Button { dismiss() } label: {
                LucideIcon(.x, size: 18)
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .accessibilityLabel(l10n("common.close"))
            .padding(Space.s4)
        }
        .environment(\.layoutDirection, .leftToRight)
        .onAppear {
            let player = AVPlayer(url: url)
            self.player = player
            player.play()
        }
        .onDisappear { player?.pause() }
    }
}

/// A picture on a message: drawn once its bytes are here; a row with its progress until then, or
/// when it cannot be drawn. A tap opens it full screen.
struct PictureAttachment: View {
    let file: HubFile
    let profile: String
    let opener: FileOpener
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var picture: UIImage?
    @State private var undrawable = false

    /// Pictures up to this size are fetched as soon as they are shown; a larger one waits for a tap.
    static let autoFetchBytes = 20 * 1024 * 1024

    var body: some View {
        let state = FileDownloads.shared.state(file)
        Group {
            if let picture, case .ready = state {
                Button { opener.open(file, profile: profile, app: app) } label: {
                    Image(uiImage: picture)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 260, maxHeight: 260, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(l10n("attachments.open", ["name": file.name]))
                .accessibilityIdentifier("message.image")
            } else {
                FileRowView(file: file, state: undrawable ? .idle : state) {
                    opener.open(file, profile: profile, app: app)
                }
            }
        }
        .task(id: file.cacheKey) {
            if (file.size ?? 0) <= Self.autoFetchBytes { FileDownloads.shared.start(file, profile: profile, app: app) }
        }
        .task(id: state.readyURL) {
            guard let url = state.readyURL else { return }
            // Decoded off the main thread, at most 780 px on its longer side, its shape kept.
            let image = await Task.detached(priority: .userInitiated) { () -> UIImage? in
                guard let full = UIImage(contentsOfFile: url.path) else { return nil }
                return full.preparingThumbnail(of: AttachmentRules.fitted(full.size, maxSide: 780)) ?? full
            }.value
            if let image { picture = image } else { undrawable = true }
        }
    }
}

extension FileDownloads.State {
    var readyURL: URL? {
        if case .ready(let url) = self { return url }
        return nil
    }
}

/// Any other file: a row that opens it.
struct OpenableFileRow: View {
    let file: HubFile
    let profile: String
    let opener: FileOpener
    @Environment(AppModel.self) private var app

    var body: some View {
        let state = FileDownloads.shared.states[file.cacheKey] ?? .idle
        FileRowView(file: file, state: state) { opener.open(file, profile: profile, app: app) }
    }
}

/// One file as a row: its kind's icon, its name (the middle elided), and under it its size, how
/// much has arrived, or why it failed, in one line. While it downloads the trailing button cancels
/// it; after a failure it tries again.
struct FileRowView: View {
    let file: HubFile
    let state: FileDownloads.State
    let open: () -> Void
    @Environment(\.l10n) private var l10n

    private var icon: Lucide {
        let type = FileKinds.mime(of: file.name, file.mime)
        if type.hasPrefix("image/") { return .image }
        if type.hasPrefix("audio/") { return .music }
        if type.hasPrefix("video/") { return .film }
        return FileKinds.openAs(file) == .viewer ? .fileText : .file
    }

    private var detail: String? {
        switch state {
        case .loading(let fraction):
            if let fraction, let size = file.size {
                return l10n("attachments.progress", [
                    "percent": String(Int(fraction * 100)),
                    "done": AttachmentRules.size(Int(Double(size) * fraction)),
                    "total": AttachmentRules.size(size),
                ])
            }
            return l10n("attachments.fetching")
        case .failed(let failure):
            if failure.status == 404 { return l10n("attachments.gone") }
            if failure.status == 413 { return l10n("attachments.open_too_large") }
            return failure.describe(l10n)
        default:
            return file.size.map { AttachmentRules.size($0) }
        }
    }

    private var failed: Bool {
        if case .failed = state { return true }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s1) {
            HStack(spacing: Space.s2) {
                LucideIcon(icon, size: 18)
                    .foregroundStyle(failed ? Tone.danger : Tone.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.name)
                        .font(.system(size: FontSize.sizeSm))
                        .foregroundStyle(Tone.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let detail {
                        Text(detail)
                            .font(.system(size: FontSize.sizeXs))
                            .foregroundStyle(failed ? Tone.danger : Tone.textMuted)
                            .lineLimit(1)
                            .accessibilityIdentifier(failed ? "message.file.error" : "message.file.detail")
                    }
                }
                Spacer(minLength: Space.s1)
                trailing
            }
            if case .loading(let fraction?) = state {
                ProgressView(value: fraction)
                    .tint(Tone.accent)
            }
        }
        .padding(.leading, Space.s3)
        .padding(.trailing, Space.s1)
        .padding(.vertical, Space.s2)
        .frame(minWidth: 200, maxWidth: 320, alignment: .leading)
        .background(Tone.surface2, in: RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            if case .loading = state { return }
            open()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(l10n("attachments.open", ["name": file.name]))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("message.file")
    }

    @ViewBuilder
    private var trailing: some View {
        switch state {
        case .loading:
            Button { FileDownloads.shared.cancel(file) } label: {
                ZStack {
                    ProgressView().controlSize(.small)
                    LucideIcon(.x, size: 12).foregroundStyle(Tone.textMuted)
                }
                .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(l10n("attachments.cancel"))
            .accessibilityIdentifier("message.file.cancel")
        case .failed:
            Button(action: open) {
                LucideIcon(.rotateCcw, size: 16)
                    .foregroundStyle(Tone.textMuted)
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(l10n("common.retry"))
        default:
            EmptyView()
        }
    }
}

/// Links in a reply that name one of the conversation's files open it as its row does (web:
/// `Markdown.tsx`, decision §48); any other link opens as before. The conversation's file list is
/// read only when a link needs it.
struct FileLinkOpener: ViewModifier {
    /// The reply's own files.
    let own: [MessageAttachments.File]
    let profile: String
    /// The conversation, for links to its working folder's files; nil in a room.
    let sessionID: String?
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var opener = FileOpener()

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in handle(url) })
            .fileOpener(opener)
            .alert(opener.notice ?? "", isPresented: Binding(get: { opener.notice != nil }, set: { if !$0 { opener.notice = nil } })) {
                Button(l10n("common.close")) { opener.notice = nil }
            }
    }

    private func handle(_ url: URL) -> OpenURLAction.Result {
        let href = url.absoluteString
        let hub = app.credentials?.hubURL
        if let file = FileLinks.resolve(href, hub: hub, own: own) {
            opener.open(file, profile: profile, app: app)
            return .handled
        }
        guard FileLinks.word(of: href, hub: hub) != nil, let sessionID else { return outside(url) }
        let scope = profile.isEmpty ? app.currentProfile : profile
        Task {
            let list = try? await app.api.call { config in
                try await SessionsAPI.sessionsListFiles(xHubProfile: scope, sessionId: sessionID, apiConfiguration: config)
            }
            if let file = FileLinks.resolve(href, hub: hub, own: own, files: list?.items, sessionID: sessionID) {
                opener.open(file, profile: profile, app: app)
            } else if url.scheme == nil || url.host == nil {
                opener.notice = l10n("attachments.link_failed")
            } else {
                _ = await UIApplication.shared.open(url)
            }
        }
        return .handled
    }

    /// A whole address opens in the system; a word the phone cannot open says so.
    private func outside(_ url: URL) -> OpenURLAction.Result {
        if url.scheme != nil { return .systemAction }
        opener.notice = l10n("attachments.link_failed")
        return .handled
    }
}

/// The files of messages, kept in the app's caches under their own names (the system viewer
/// tells a file's kind by its extension). The system empties the caches when it needs the space.
enum AttachmentFiles {
    /// Where a file is kept: a folder per attachment, the file under its own (safe) name.
    static func place(_ id: String, name: String, in root: URL) -> URL {
        root.appendingPathComponent(id, isDirectory: true).appendingPathComponent(HubFileFetcher.safeName(name, fallback: id))
    }
}

/// The hub's attachment calls the uploader uses, so its rules are tested without a network.
protocol AttachmentBackend {
    func oneShot(_ file: URL, profile: String) async throws -> Attachment
    func start(_ start: UploadStart, profile: String) async throws -> Upload
    func chunk(_ uploadID: String, offset: Int, body: URL, profile: String) async throws -> Upload
    func complete(_ uploadID: String, profile: String) async throws -> Attachment
    func abort(_ uploadID: String, profile: String) async
}

/// Uploads one file as the web does: in one request up to 25 MB, in chunks (the resumable flow)
/// above it, up to the hub's largest attachment.
struct AttachmentUploader {
    let backend: AttachmentBackend

    func upload(_ file: URL, profile: String) async throws -> Attachment {
        let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if size <= AttachmentRules.maxOneShotBytes { return try await backend.oneShot(file, profile: profile) }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let open = try await backend.start(
            UploadStart(name: file.lastPathComponent, mime: mime, sizeBytes: size, purpose: .message),
            profile: profile
        )
        do {
            let reader = try FileHandle(forReadingFrom: file)
            defer { try? reader.close() }
            let part = FileManager.default.temporaryDirectory.appendingPathComponent("chunk-\(open.id)")
            defer { try? FileManager.default.removeItem(at: part) }
            var offset = open.nextOffset
            while offset < size {
                try reader.seek(toOffset: UInt64(offset))
                let bytes = try reader.read(upToCount: max(1, open.chunkBytes)) ?? Data()
                guard !bytes.isEmpty else { break }
                try bytes.write(to: part)
                // The hub answers where it stands now; a resent chunk moves nothing twice.
                let next = try await backend.chunk(open.id, offset: offset, body: part, profile: profile).nextOffset
                guard next > offset else { throw HubFailure(kind: .other, status: 0, code: nil, message: nil, operationID: "sessions.uploadChunk", requestID: nil, detail: "no progress") }
                offset = next
            }
            return try await backend.complete(open.id, profile: profile)
        } catch {
            await backend.abort(open.id, profile: profile)
            throw error
        }
    }
}

/// `AttachmentBackend` through the generated client only.
struct HubAttachmentBackend: AttachmentBackend {
    let api: HubAPI

    func oneShot(_ file: URL, profile: String) async throws -> Attachment {
        try await api.call {
            try await SessionsAPI.sessionsUploadAttachment(xHubProfile: profile, file: file, purpose: .message, apiConfiguration: $0)
        }
    }

    func start(_ start: UploadStart, profile: String) async throws -> Upload {
        try await api.call { try await SessionsAPI.sessionsStartUpload(xHubProfile: profile, uploadStart: start, apiConfiguration: $0) }
    }

    func chunk(_ uploadID: String, offset: Int, body: URL, profile: String) async throws -> Upload {
        try await api.call {
            try await SessionsAPI.sessionsUploadChunk(xHubProfile: profile, uploadId: uploadID, offset: offset, body: body, apiConfiguration: $0)
        }
    }

    func complete(_ uploadID: String, profile: String) async throws -> Attachment {
        try await api.call { try await SessionsAPI.sessionsCompleteUpload(xHubProfile: profile, uploadId: uploadID, apiConfiguration: $0) }
    }

    func abort(_ uploadID: String, profile: String) async {
        _ = try? await api.call { try await SessionsAPI.sessionsAbortUpload(xHubProfile: profile, uploadId: uploadID, apiConfiguration: $0) }
    }
}
