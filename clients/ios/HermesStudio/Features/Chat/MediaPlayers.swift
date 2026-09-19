import AVFoundation
import AVKit
import SwiftUI

extension APIClient {
    /// Streaming URL for `/api/studio/files/download` (server supports HTTP
    /// ranges); the token goes in the `Authorization` header, never the URL.
    func mediaURL(path: String, name: String, profile: String) throws -> URL {
        guard let url = try downloadRequest(path: path, name: name, profile: profile).url else { throw HermesError.invalidServer }
        return url
    }

    var bearerHeaders: [String: String] { token.isEmpty ? [:] : ["Authorization": "Bearer \(token)"] }

    /// `AVURLAsset` with the bearer header (`AVURLAssetHTTPHeaderFieldsKey`
    /// is honoured for range requests during playback).
    func mediaAsset(path: String, name: String, profile: String) throws -> AVURLAsset {
        AVURLAsset(url: try mediaURL(path: path, name: name, profile: profile), options: ["AVURLAssetHTTPHeaderFieldsKey": bearerHeaders])
    }
}

/// Video / audio inline players, or a download card, plus the "on the device"
/// badge for `device://` links.
struct MediaAttachmentView: View {
    let link: DownloadLink
    let api: APIClient
    let profile: String
    /// Group-room files are served by `/rooms/{roomId}/attachments/{file}`.
    var roomID: String? = nil

    private var fileName: String { ChatFiles.fileName(for: link) }

    private var asset: AVURLAsset? {
        if let roomID, let url = try? api.roomAttachmentRequest(roomID: roomID, path: link.path, name: fileName).url {
            return AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": api.bearerHeaders])
        }
        return try? api.mediaAsset(path: link.path, name: fileName, profile: profile)
    }

    private func download() async throws -> URL {
        if let roomID { return try await api.downloadRoomAttachment(roomID: roomID, path: link.path, name: fileName) }
        return try await api.downloadFile(path: link.path, name: fileName, profile: profile)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch link.mediaKind {
            case .video:
                InlineVideoPlayer(asset: asset, title: link.label)
            case .audio:
                InlineAudioPlayer(asset: asset, title: link.label)
            case .image, .file:
                FileDownloadCard(link: link, fetch: { try await download() })
            }
            if link.isDeviceFile { DeviceFileBadge() }
        }
    }
}

struct DeviceFileBadge: View {
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "iphone").font(.system(size: 10, weight: .medium))
            Text("On the device")
        }
        .font(CoreHubTokens.Typography.metaFont)
        .foregroundStyle(CoreHubTokens.Palette.info)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(CoreHubTokens.Palette.info.opacity(CoreHubTokens.Alpha.selected), in: Capsule())
        .accessibilityLabel("On the device")
    }
}

struct InlineVideoPlayer: View {
    let asset: AVURLAsset?
    let title: String
    @State private var player: AVPlayer?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let player {
                VideoPlayer(player: player)
                    .frame(height: 210)
                    .clipShape(RoundedRectangle(cornerRadius: CoreHubTokens.Radius.bubble, style: .continuous))
            } else {
                Text("Video is unavailable").font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.error)
            }
            Text(title).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.textMuted).lineLimit(1)
        }
        .onAppear { if player == nil, let asset { player = AVPlayer(playerItem: AVPlayerItem(asset: asset)) } }
        .onDisappear { player?.pause() }
    }
}

/// Small transport for audio files: play/pause, elapsed / duration, progress.
struct InlineAudioPlayer: View {
    let asset: AVURLAsset?
    let title: String
    @StateObject private var model = AudioPlayerModel()

    var body: some View {
        HStack(spacing: 10) {
            Button { model.toggle() } label: {
                Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(CoreHubTokens.Palette.textOnAccent)
                    .frame(width: 32, height: 32)
                    .background(CoreHubTokens.Palette.accent, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(asset == nil)
            .accessibilityLabel(model.isPlaying ? "Pause" : "Play voice")
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(CoreHubTokens.Typography.font(CoreHubTokens.Typography.sidebarTab, weight: .medium)).lineLimit(1)
                ZStack(alignment: .leading) {
                    Capsule().fill(CoreHubTokens.Palette.border)
                    GeometryReader { geometry in
                        Capsule().fill(CoreHubTokens.Palette.accent).frame(width: geometry.size.width * model.progress)
                    }
                }
                .frame(height: 4)
                HStack {
                    Text(AudioPlayerModel.clock(model.elapsed))
                    Spacer()
                    Text(AudioPlayerModel.clock(model.duration))
                }
                .font(CoreHubTokens.Typography.metaFont.monospacedDigit())
                .foregroundStyle(CoreHubTokens.Palette.textMuted)
                .environment(\.layoutDirection, .leftToRight)
                if let error = model.error {
                    Text(error).font(CoreHubTokens.Typography.metaFont).foregroundStyle(CoreHubTokens.Palette.error)
                }
            }
        }
        .padding(10)
        .background(CoreHubTokens.Palette.bgCard, in: RoundedRectangle(cornerRadius: CoreHubTokens.Radius.bubble, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: CoreHubTokens.Radius.bubble, style: .continuous).stroke(CoreHubTokens.Palette.borderLight))
        .onAppear { if let asset { model.load(asset) } }
        .onDisappear { model.pause() }
    }
}

@MainActor
final class AudioPlayerModel: ObservableObject {
    @Published var isPlaying = false
    @Published var elapsed: Double = 0
    @Published var duration: Double = 0
    @Published var error: String?
    private var player: AVPlayer?
    private var observer: Any?
    private var endObserver: NSObjectProtocol?

    var progress: Double { duration > 0 ? min(1, elapsed / duration) : 0 }

    static func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    func load(_ asset: AVURLAsset) {
        guard player == nil else { return }
        let item = AVPlayerItem(asset: asset)
        let player = AVPlayer(playerItem: item)
        self.player = player
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] time in
            Task { @MainActor in
                guard let self else { return }
                self.elapsed = time.seconds
                let total = item.duration.seconds
                if total.isFinite && total > 0 { self.duration = total }
                if let failure = item.error { self.error = failure.localizedDescription; self.isPlaying = false }
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.isPlaying = false
                self?.player?.seek(to: .zero)
                self?.elapsed = 0
            }
        }
    }

    func toggle() { isPlaying ? pause() : play() }

    func play() {
        guard let player else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        player.play(); isPlaying = true
    }

    func pause() { player?.pause(); isPlaying = false }
}
