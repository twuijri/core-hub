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

    /// The QR's JSON, or the `corehub://pair?hub=…&id=…&code=…` link the web offers to copy
    /// (the desktop app and the Android app read the same two forms).
    static func parse(_ text: String, now: Date = Date()) -> Result<PairingPayload, Failure> {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("\(Product.id):") { return parseLink(trimmed) }
        guard let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String,
              type == Product.pairingType || type == Product.legacyPairingType
        else { return .failure(.notAPairingCode) }
        var expiresAt: Date?
        if let raw = object["expires_at"] as? String {
            expiresAt = HubDate.parse(raw)
            if let expiresAt, expiresAt < now { return .failure(.expired) }
        }
        return make(hub: object["hub_url"] as? String, id: object["pairing_id"] as? String,
                    code: object["code"] as? String, expiresAt: expiresAt)
    }

    static func parseLink(_ text: String) -> Result<PairingPayload, Failure> {
        guard let components = URLComponents(string: text),
              components.scheme?.lowercased() == Product.id else { return .failure(.notAPairingCode) }
        // `corehub://pair?…` has the host `pair`; `corehub:pair?…` has the path.
        let action = ((components.host ?? "") + components.path).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard action == "pair" else { return .failure(.notAPairingCode) }
        let value = { (name: String) in components.queryItems?.first { $0.name == name }?.value }
        return make(hub: value("hub"), id: value("id"), code: value("code"), expiresAt: nil)
    }

    private static func make(hub: String?, id: String?, code: String?, expiresAt: Date?) -> Result<PairingPayload, Failure> {
        guard let hub, let hubURL = HubAddress.normalise(hub),
              let id = id?.trimmingCharacters(in: .whitespaces).uppercased(),
              id.range(of: "^[0-9A-HJKMNP-TV-Z]{26}$", options: .regularExpression) != nil,
              let code = code?.trimmingCharacters(in: .whitespaces).uppercased(),
              code.range(of: "^[A-Z0-9-]{4,32}$", options: .regularExpression) != nil
        else { return .failure(.notAPairingCode) }
        return .success(PairingPayload(hubURL: hubURL, pairingID: id, code: code, expiresAt: expiresAt))
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
