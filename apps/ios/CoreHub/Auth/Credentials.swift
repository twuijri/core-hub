// What the phone keeps to talk to its hub. The whole value lives in the Keychain (never in
// UserDefaults): the tokens are the person's access.
import Foundation
import Security

struct Credentials: Codable, Equatable {
    enum Kind: String, Codable {
        /// Signed in with a username and password: a short JWT plus a rotating refresh token.
        case password
        /// Paired by QR: a long-lived app token (`hub_at_…`) that identifies this device.
        case device
    }

    var hubURL: URL
    var kind: Kind
    /// The bearer: a JWT for `password`, the app token for `device`.
    var accessToken: String
    var refreshToken: String?
    /// When `accessToken` stops working (`password` only).
    var accessExpiresAt: Date?
    /// When the app token was last renewed (`device` only).
    var renewedAt: Date?
    var userID: String
    var username: String
    var displayName: String
    var role: String
    /// The profiles the person may enter (from `User.profiles`).
    var profiles: [String]
    var defaultProfile: String
    /// This phone's row in the hub's device list, once known: from the pairing claim, or from
    /// `devices.register` for a password sign-in (PushCenter). The APNs token is registered on it.
    var deviceID: String? = nil

    /// Whether the access token should be refreshed before the next request.
    func needsRefresh(now: Date = Date(), margin: TimeInterval = 30) -> Bool {
        guard kind == .password, let expires = accessExpiresAt else { return false }
        return expires.timeIntervalSince(now) < margin
    }

    /// A device's app token is renewed at most once a day (the hub renews when < 7 days
    /// remain, and does not say the new expiry).
    func needsRenewal(now: Date = Date()) -> Bool {
        guard kind == .device else { return false }
        guard let renewedAt else { return true }
        return now.timeIntervalSince(renewedAt) > 24 * 3600
    }
}

/// A single Keychain item holding the JSON of `Credentials`.
struct KeychainStore {
    var service = Product.storagePrefix + "credentials"
    var account = "hub"

    func read() -> Credentials? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder.hub.decode(Credentials.self, from: data)
    }

    @discardableResult
    func save(_ credentials: Credentials) -> Bool {
        guard let data = try? JSONEncoder.hub.encode(credentials) else { return false }
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

extension JSONDecoder {
    static let hub: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

extension JSONEncoder {
    static let hub: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

/// A stable id this installation keeps, so pairing again updates the same device row.
enum DeviceKey {
    static func current(defaults: UserDefaults = .standard) -> String {
        let key = Product.storagePrefix + "device_key"
        if let existing = defaults.string(forKey: key) { return existing }
        let fresh = UUID().uuidString.lowercased()
        defaults.set(fresh, forKey: key)
        return fresh
    }
}
