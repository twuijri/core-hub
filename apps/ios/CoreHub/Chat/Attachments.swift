// Files in the composer (owner, 2026-09-25): the «+» button offers a photo from the library,
// the camera, or a file. Each one is uploaded to the hub as soon as it is picked
// (`sessions.uploadAttachment`, or the resumable `sessions.startUpload` flow above 25 MB, as the
// web's composer does), shows as a chip with a preview and a remove button, and goes with the next
// message as an image or file block.
//
// Photos go «Compressed» or at «Original quality», as in Telegram (owner, 2026-09-26: «خله خيارين
// مثل التيليقرام مع ضغط ولا بدون»): the choice sits in the «+» menu and is remembered.
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

/// The files a message carries, under its text (web: the message's attachment row, #154): a
/// picture is drawn in place, anything else is its name. A tap opens either full screen in the
/// system's viewer — zoom, and the share sheet to save or send it on. The bytes come with the
/// bearer header (`sessions.downloadAttachment`), never a token in a URL.
struct MessageAttachments: View {
    let content: [ContentBlock]
    /// The chat's profile, which the files belong to.
    var profile: String = ""
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var open: URL?
    @State private var opening: String?

    struct File: Identifiable, Equatable {
        let id: Int
        let attachmentID: String
        let name: String
        let isImage: Bool
    }

    static func files(_ content: [ContentBlock]) -> [File] {
        content.enumerated().compactMap { index, block in
            switch block {
            case .typeImageBlock(let image): return File(id: index, attachmentID: image.attachmentId, name: image.name ?? "image", isImage: true)
            case .typeFileBlock(let file): return File(id: index, attachmentID: file.attachmentId, name: file.name ?? "file", isImage: false)
            case .typeAudioBlock(let audio): return File(id: index, attachmentID: audio.attachmentId, name: audio.name ?? "audio", isImage: false)
            default: return nil
            }
        }
    }

    var body: some View {
        let files = Self.files(content)
        if !files.isEmpty {
            VStack(alignment: .leading, spacing: Space.s1) {
                ForEach(files) { file in
                    if file.isImage {
                        InlineImage(file: file, profile: profile, chip: chip(file)) { open = $0 }
                    } else {
                        Button { Task { await show(file) } } label: { chip(file) }
                            .buttonStyle(.plain)
                            .accessibilityLabel(l10n("attachments.open", ["name": file.name]))
                    }
                }
            }
            .quickLookPreview($open)
            .accessibilityIdentifier("message.attachments")
        }
    }

    private func chip(_ file: File) -> some View {
        HStack(spacing: Space.s1) {
            if opening == file.attachmentID {
                ProgressView().controlSize(.mini)
            } else {
                Image(lucide: file.isImage ? .image : .fileText)
                    .resizable()
                    .frame(width: 14, height: 14)
            }
            Text(file.name)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .font(.system(size: FontSize.sizeSm))
        .foregroundStyle(Tone.textMuted)
    }

    private func show(_ file: File) async {
        opening = file.attachmentID
        defer { opening = nil }
        open = await AttachmentFiles.shared.file(file.attachmentID, name: file.name, profile: profile, app: app)
    }
}

/// A picture on a message, drawn in place once its bytes are here; its name until then, or if
/// they cannot be fetched. A tap opens it full screen.
struct InlineImage<Chip: View>: View {
    let file: MessageAttachments.File
    let profile: String
    let chip: Chip
    let onOpen: (URL) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.l10n) private var l10n
    @State private var loaded: (url: URL, image: UIImage)?

    var body: some View {
        Group {
            if let loaded {
                Button { onOpen(loaded.url) } label: {
                    Image(uiImage: loaded.image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 260, maxHeight: 260, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.md, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(l10n("attachments.open", ["name": file.name]))
                .accessibilityIdentifier("message.image")
            } else {
                chip
            }
        }
        .task(id: file.attachmentID) {
            guard let url = await AttachmentFiles.shared.file(file.attachmentID, name: file.name, profile: profile, app: app) else { return }
            // Decoded off the main thread: a photo from the camera is large.
            let image = await Task.detached(priority: .userInitiated) { UIImage(contentsOfFile: url.path)?.preparingThumbnail(of: CGSize(width: 780, height: 780)) }.value
            if let image { loaded = (url, image) }
        }
    }
}

/// The files of messages, fetched once and kept in the app's caches under their own names (the
/// system viewer tells a file's kind by its extension). The system empties the caches when it
/// needs the space.
@MainActor
final class AttachmentFiles {
    static let shared = AttachmentFiles()
    private var inFlight: [String: Task<URL?, Never>] = [:]

    private var root: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("attachments", isDirectory: true)
    }

    /// Where a file is kept: a folder per attachment, the file under its own (safe) name.
    nonisolated static func place(_ id: String, name: String, in root: URL) -> URL {
        let safe = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        return root.appendingPathComponent(id, isDirectory: true).appendingPathComponent(safe.isEmpty ? id : safe)
    }

    func file(_ id: String, name: String, profile: String, app: AppModel) async -> URL? {
        let target = Self.place(id, name: name, in: root)
        if FileManager.default.fileExists(atPath: target.path) { return target }
        if let running = inFlight[id] { return await running.value }
        let task = Task<URL?, Never> {
            let scope = profile.isEmpty ? app.currentProfile : profile
            guard let downloaded = try? await app.api.call({
                try await SessionsAPI.sessionsDownloadAttachment(xHubProfile: scope, attachmentId: id, apiConfiguration: $0)
            }) else { return nil }
            do {
                try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? FileManager.default.removeItem(at: target)
                try FileManager.default.moveItem(at: downloaded, to: target)
                return target
            } catch {
                return nil
            }
        }
        inFlight[id] = task
        let url = await task.value
        inFlight[id] = nil
        return url
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
