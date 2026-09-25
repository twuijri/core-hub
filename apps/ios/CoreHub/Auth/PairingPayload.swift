// The QR code the web shows under Settings → Device connections → App (auth.createPairing):
// `{ type: "corehub.pairing", hub_url, pairing_id, code, expires_at }`. Pure parsing, tested
// in PairingPayloadTests.
import Foundation

struct PairingPayload: Equatable {
    let hubURL: URL
    let pairingID: String
    let code: String
    let expiresAt: Date?

    enum Failure: Error, Equatable {
        /// Not JSON, not ours, or missing a field.
        case notAPairingCode
        case expired
    }

    static func parse(_ text: String, now: Date = Date()) -> Result<PairingPayload, Failure> {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String,
              type == Product.pairingType || type == Product.legacyPairingType,
              let rawURL = object["hub_url"] as? String,
              let hubURL = HubAddress.normalise(rawURL),
              let pairingID = object["pairing_id"] as? String, !pairingID.isEmpty,
              let code = object["code"] as? String, !code.isEmpty
        else { return .failure(.notAPairingCode) }
        var expiresAt: Date?
        if let raw = object["expires_at"] as? String {
            expiresAt = HubDate.parse(raw)
            if let expiresAt, expiresAt < now { return .failure(.expired) }
        }
        return .success(PairingPayload(hubURL: hubURL, pairingID: pairingID, code: code, expiresAt: expiresAt))
    }
}

/// What a person types as the hub's address, made into the origin every request starts from.
enum HubAddress {
    /// `hub.example.com` → `https://hub.example.com`; keeps a path prefix; drops a trailing
    /// slash, a query and a fragment. `nil` when it is not an http(s) address.
    static func normalise(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(" ") else { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard var components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil else { return nil }
        components.scheme = scheme
        components.query = nil
        components.fragment = nil
        while components.path.hasSuffix("/") { components.path.removeLast() }
        return components.url
    }

    /// The WebSocket URL of the realtime engine (`/rt/`, ARCHITECTURE §Realtime).
    static func realtimeURL(for hub: URL) -> URL? {
        guard var components = URLComponents(url: hub, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path += "/rt/"
        components.queryItems = [
            URLQueryItem(name: "EIO", value: "4"),
            URLQueryItem(name: "transport", value: "websocket"),
        ]
        return components.url
    }
}

enum HubDate {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ text: String) -> Date? {
        withFraction.date(from: text) ?? plain.date(from: text)
    }
}
