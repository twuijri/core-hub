// Opening the files of a conversation on the phone (docs/changes/2026-09-26-twuijri-mobile-open-files.md):
// which way a file opens, which file a link in a reply names, and the download itself — through the
// generated client only, the bearer in the header (HubAPI), with progress and cancel. The rules are
// pure and tested (HubFilesTests); the views are in Attachments.swift.
import CoreHubClient
import CryptoKit
import Foundation

/// A file of the hub a message carries or a reply's link names.
enum HubFile: Hashable {
    /// An attachment: its bytes never change (`sessions.downloadAttachment`).
    case attachment(id: String, name: String, mime: String?, size: Int?)
    /// A file of the conversation's working folder (`sessions.readFile`); it may change.
    case working(sessionID: String, path: String, name: String, mime: String?, size: Int?, modified: Date?)

    var name: String {
        switch self {
        case .attachment(_, let name, _, _), .working(_, _, let name, _, _, _): return name
        }
    }

    var mime: String? {
        switch self {
        case .attachment(_, _, let mime, _), .working(_, _, _, let mime, _, _): return mime
        }
    }

    var size: Int? {
        switch self {
        case .attachment(_, _, _, let size), .working(_, _, _, _, let size, _): return size
        }
    }

    /// The folder it is kept under in the phone's caches: the attachment's id, or a digest of the
    /// working file's place, size and time (a changed file is fetched again).
    var cacheKey: String {
        switch self {
        case .attachment(let id, _, _, _):
            return id
        case .working(let session, let path, _, _, let size, let modified):
            let seed = "\(session)\u{0}\(path)\u{0}\(size.map(String.init) ?? "")\u{0}\(modified.map { String($0.timeIntervalSince1970) } ?? "")"
            let digest = Insecure.SHA1.hash(data: Data(seed.utf8)).map { String(format: "%02x", $0) }.joined()
            return "file-" + digest.prefix(24)
        }
    }

    /// An entry of `sessions.listFiles`: its attachment when it is one, else the folder's file.
    static func of(_ file: SessionFile, sessionID: String) -> HubFile {
        if let id = file.attachmentId { return .attachment(id: id, name: file.name, mime: file.mime, size: file.sizeBytes) }
        return .working(sessionID: sessionID, path: file.path ?? file.name, name: file.name, mime: file.mime, size: file.sizeBytes, modified: file.modifiedAt)
    }
}

/// How a file opens: drawn by the app, in the system's viewer (Quick Look), played, or shared.
enum FileOpen: Equatable {
    case picture, viewer, media, share
}

enum FileKinds {
    /// Pictures the app draws itself (an SVG is not one: it opens in the viewer).
    private static let pictures: Set<String> = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/bmp"]

    private static let byExtension: [String: String] = [
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp",
        "heic": "image/heic", "heif": "image/heif", "bmp": "image/bmp", "svg": "image/svg+xml",
        "pdf": "application/pdf", "txt": "text/plain", "md": "text/markdown", "csv": "text/csv",
        "json": "application/json", "html": "text/html", "htm": "text/html", "xml": "text/xml", "log": "text/plain",
        "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav", "ogg": "audio/ogg",
        "oga": "audio/ogg", "opus": "audio/ogg", "flac": "audio/flac", "weba": "audio/webm",
        "mp4": "video/mp4", "m4v": "video/mp4", "mov": "video/quicktime", "webm": "video/webm", "mkv": "video/x-matroska",
        "doc": "application/msword", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls": "application/vnd.ms-excel", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt": "application/vnd.ms-powerpoint", "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "epub": "application/epub+zip", "rtf": "application/rtf",
    ]

    /// Opened in the system's viewer: documents and text. Anything else is shared or saved.
    private static let documents: Set<String> = [
        "application/pdf", "application/json", "application/rtf", "application/epub+zip", "image/svg+xml",
        "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
    ]

    /// The file's type: the hub's, unless it says nothing (`application/octet-stream`); then its name's.
    static func mime(of name: String, _ mime: String?) -> String {
        let given = (mime ?? "").split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        if !given.isEmpty, given != "application/octet-stream" { return given }
        let ext = (name as NSString).pathExtension.lowercased()
        return byExtension[ext] ?? "application/octet-stream"
    }

    static func openAs(_ name: String, _ mime: String?) -> FileOpen {
        let type = self.mime(of: name, mime)
        if pictures.contains(type) { return .picture }
        if type.hasPrefix("audio/") || type.hasPrefix("video/") { return .media }
        if type.hasPrefix("text/") || documents.contains(type) || type.hasPrefix("application/vnd.openxmlformats-officedocument.") { return .viewer }
        return .share
    }

    static func openAs(_ file: HubFile) -> FileOpen { openAs(file.name, file.mime) }
}

/// Which file of the hub a link in a reply names (web: `Markdown.tsx`, decision §48): the address of
/// one of the reply's attachments (relative, or on the hub's own origin), or a word that is one of
/// the conversation's files — its path, a path ending in it, or its name when one file has it (the
/// reply's own files first). Any other link is an ordinary link.
enum FileLinks {
    /// The address a hub serves an attachment's bytes at, as the generated client builds it.
    static func contentPath(_ attachmentID: String) -> String {
        let config = CoreHubClientAPIConfiguration(basePath: CoreHubClientAPIConfiguration().basePath)
        return SessionsAPI.sessionsDownloadAttachmentWithRequestBuilder(xHubProfile: "", attachmentId: attachmentID, apiConfiguration: config).URLString
    }

    /// The link as a word: decoded, without a query or fragment; nil when it points off the hub.
    static func word(of href: String, hub: URL?) -> String? {
        let raw = href.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty || raw.hasPrefix("#") || raw.hasPrefix("//") { return nil }
        var path = raw
        if let colon = raw.firstIndex(of: ":"),
           raw[raw.startIndex..<colon].range(of: #"^[A-Za-z][A-Za-z0-9+.\-]*$"#, options: .regularExpression) != nil {
            let scheme = raw[raw.startIndex..<colon].lowercased()
            switch scheme {
            case "http", "https":
                guard let url = URLComponents(string: raw), let hub, let home = URLComponents(url: hub, resolvingAgainstBaseURL: false),
                      url.scheme?.lowercased() == home.scheme?.lowercased(), url.host?.lowercased() == home.host?.lowercased(),
                      (url.port ?? defaultPort(url.scheme)) == (home.port ?? defaultPort(home.scheme)) else { return nil }
                path = url.percentEncodedPath
            case "sandbox", "file":
                // What agents write for a file they made: `sandbox:/…`, `file:///…`.
                let rest = raw[raw.index(after: colon)...].drop { $0 == "/" }
                path = "/" + rest
            default:
                return nil
            }
        }
        if let cut = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<cut]) }
        let decoded = path.removingPercentEncoding ?? path
        return decoded.isEmpty ? nil : decoded
    }

    private static func defaultPort(_ scheme: String?) -> Int? {
        switch scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }

    /// The file `href` names, or nil for an ordinary link. `files` is the conversation's list, when read.
    static func resolve(_ href: String, hub: URL?, own: [MessageAttachments.File], files: [SessionFile]? = nil, sessionID: String? = nil) -> HubFile? {
        guard let word = word(of: href, hub: hub) else { return nil }
        for file in own where word == file.url || word == contentPath(file.attachmentID) {
            return file.hubFile
        }
        let known = files ?? []
        if let entry = known.first(where: { $0.attachmentId.map { word == contentPath($0) } ?? false }) {
            return HubFile.of(entry, sessionID: sessionID ?? "")
        }
        var mention = word.trimmingCharacters(in: .whitespaces)
        if mention.hasPrefix("./") { mention.removeFirst(2) }
        guard !mention.isEmpty, mention.count <= 4096, !mention.contains(where: { $0.isNewline || $0 == "\t" }) else { return nil }
        let base = (mention as NSString).lastPathComponent
        // The reply's own file of that name first: `flying_cat.png` means the one it carries.
        let mine = own.filter { $0.name == base }
        if mine.count == 1 { return mine[0].hubFile }
        guard let sessionID else { return nil }
        if let exact = known.first(where: { entry in entry.path.map { mention == $0 || mention.hasSuffix("/" + $0) } ?? false }) {
            return HubFile.of(exact, sessionID: sessionID)
        }
        let named = known.filter { $0.name == base }
        return named.count == 1 ? HubFile.of(named[0], sessionID: sessionID) : nil
    }
}

/// Fetching one file of the hub, one attempt with a given configuration of the generated client
/// (HubAPI.call adds the bearer and retries once after a refresh).
enum HubFileFetcher {
    /// Where a file is kept: a folder per file, under its own (safe) name so Quick Look knows its kind.
    static func place(_ file: HubFile, in root: URL) -> URL {
        root.appendingPathComponent(file.cacheKey, isDirectory: true).appendingPathComponent(safeName(file.name, fallback: file.cacheKey))
    }

    /// A name that stays inside its folder: no separators, never empty.
    static func safeName(_ name: String, fallback: String) -> String {
        let safe = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_").replacingOccurrences(of: ":", with: "_")
            .trimmingCharacters(in: .whitespaces)
        return safe.isEmpty ? fallback : String(safe.suffix(200))
    }

    /// The file when it is already here, whole.
    static func cached(_ file: HubFile, in root: URL) -> URL? {
        let url = place(file, in: root)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        if let size = file.size, let stored = attributes[.size] as? Int, stored != size { return nil }
        return url
    }

    /// Downloads `file` with `config`; `progress` hears the fraction as bytes arrive (nil while unknown).
    static func download(_ file: HubFile, profile: String, config: CoreHubClientAPIConfiguration, progress: @escaping @Sendable (Double?) -> Void) async throws -> URL {
        let builder: RequestBuilder<URL>
        switch file {
        case .attachment(let id, _, _, _):
            builder = SessionsAPI.sessionsDownloadAttachmentWithRequestBuilder(xHubProfile: profile, attachmentId: id, apiConfiguration: config)
        case .working(let session, let path, _, _, _, _):
            builder = SessionsAPI.sessionsReadFileWithRequestBuilder(xHubProfile: profile, sessionId: session, path: path, download: true, apiConfiguration: config)
        }
        let watcher = ProgressWatcher(progress)
        builder.onProgressReady = { watcher.watch($0) }
        defer { watcher.stop() }
        return try await builder.execute().body
    }

    /// Moves what the generated client wrote into the file's place, replacing an older copy.
    static func keep(_ downloaded: URL, as file: HubFile, in root: URL) throws -> URL {
        let target = place(file, in: root)
        let manager = FileManager.default
        try manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? manager.removeItem(at: target)
        try manager.moveItem(at: downloaded, to: target)
        return target
    }

    /// An address the system's player streams an audio or video file from, with byte ranges and
    /// no bearer: the contract's one-hour ticket for this one file (DECISIONS §90, §98), resolved
    /// against the hub.
    static func streamAddress(_ file: HubFile, profile: String, hub: URL, config: CoreHubClientAPIConfiguration) async throws -> URL {
        let ticket: AttachmentStream
        switch file {
        case .attachment(let id, _, _, _):
            ticket = try await SessionsAPI.sessionsCreateAttachmentStream(xHubProfile: profile, attachmentId: id, apiConfiguration: config)
        case .working(let session, let path, _, _, _, _):
            ticket = try await SessionsAPI.sessionsCreateFileStream(
                xHubProfile: profile, sessionId: session, sessionsCreateFileStreamRequest: SessionsCreateFileStreamRequest(path: path), apiConfiguration: config
            )
        }
        guard let address = resolve(ticket.url, against: hub) else { throw HubFailure(kind: .decode, status: 200, code: nil, message: nil, operationID: nil, requestID: nil, detail: ticket.url) }
        return address
    }

    /// `url` (relative to the hub, or whole) as a whole address on the hub.
    static func resolve(_ url: String, against hub: URL) -> URL? {
        URL(string: url, relativeTo: hub)?.absoluteURL
    }
}

/// Reports a download's `Progress` as a fraction, until stopped.
final class ProgressWatcher: @unchecked Sendable {
    private let report: @Sendable (Double?) -> Void
    private var observation: NSKeyValueObservation?
    private let lock = NSLock()

    init(_ report: @escaping @Sendable (Double?) -> Void) {
        self.report = report
    }

    func watch(_ progress: Progress) {
        let report = self.report
        let observation = progress.observe(\.fractionCompleted, options: [.new]) { progress, _ in
            report(progress.totalUnitCount > 0 ? progress.fractionCompleted : nil)
        }
        lock.lock()
        self.observation = observation
        lock.unlock()
    }

    func stop() {
        lock.lock()
        observation?.invalidate()
        observation = nil
        lock.unlock()
    }
}

/// The downloads of a conversation's files, one per file, for the app's life: an inline picture
/// and a tap on it share one download, leaving the chat does not cut a large one short, and a
/// person can cancel it.
@MainActor
@Observable
final class FileDownloads {
    enum State: Equatable {
        case idle
        /// The fraction arrived, nil while the hub has not said how large the file is.
        case loading(Double?)
        case ready(URL)
        case failed(HubFailure)
    }

    static let shared = FileDownloads()

    private(set) var states: [String: State] = [:]
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]

    private var root: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("attachments", isDirectory: true)
    }

    func state(_ file: HubFile) -> State {
        if let state = states[file.cacheKey] { return state }
        if let url = HubFileFetcher.cached(file, in: root) { return .ready(url) }
        return .idle
    }

    /// Starts fetching `file` unless it is here or on its way.
    func start(_ file: HubFile, profile: String, app: AppModel) {
        let key = file.cacheKey
        if case .ready(let url) = state(file), FileManager.default.fileExists(atPath: url.path) {
            states[key] = .ready(url)
            return
        }
        if tasks[key] != nil { return }
        states[key] = .loading(nil)
        let root = self.root
        let scope = profile.isEmpty ? app.currentProfile : profile
        tasks[key] = Task {
            do {
                let downloaded = try await app.api.call { config in
                    try await HubFileFetcher.download(file, profile: scope, config: config) { fraction in
                        Task { @MainActor in
                            guard case .loading = FileDownloads.shared.states[key] else { return }
                            FileDownloads.shared.states[key] = .loading(fraction)
                        }
                    }
                }
                let kept = try HubFileFetcher.keep(downloaded, as: file, in: root)
                self.finish(key, .ready(kept))
            } catch {
                if Task.isCancelled { self.finish(key, nil) } else { self.finish(key, .failed(HubFailure(error))) }
            }
        }
    }

    private func finish(_ key: String, _ state: State?) {
        tasks[key] = nil
        states[key] = state
    }

    /// Stops a download; the file goes back to not fetched.
    func cancel(_ file: HubFile) {
        tasks.removeValue(forKey: file.cacheKey)?.cancel()
        states[file.cacheKey] = nil
    }

    /// The player's address for an audio or video file (a one-hour ticket).
    func streamAddress(_ file: HubFile, profile: String, app: AppModel) async throws -> URL {
        guard let hub = app.credentials?.hubURL else { throw HubFailure.signedOut }
        let scope = profile.isEmpty ? app.currentProfile : profile
        return try await app.api.call { config in
            try await HubFileFetcher.streamAddress(file, profile: scope, hub: hub, config: config)
        }
    }
}
