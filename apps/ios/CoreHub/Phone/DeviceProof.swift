// The push relay's device proof (ADR 0024 §6, the contract's `PushRelayProof`). A hub with no
// APNs key of its own pushes through the Core Hub relay, which binds this phone's token to the
// first hub that asks. When the phone signs in to another hub without signing out of the first,
// this proof moves the token at once instead of after 30 days: a P-256 key made once for this
// install, kept in the Keychain, signs `corehub-push-bind-v1`, the platform, the token and the
// time; the hub forwards it to the relay unread. The relay moves a binding only for a newer
// proof from the key it recorded first.
import CoreHubClient
import CryptoKit
import Foundation
import Security

/// Where this install's proof key lives.
protocol ProofKeyStore {
    func read() -> Data?
    /// True when the key is kept: a key that is not kept proves nothing the next time.
    func write(_ data: Data) -> Bool
}

/// The Keychain, on this device only (never in a backup that lands on another phone), readable
/// after the first unlock since a new APNs token may arrive with the phone locked.
struct KeychainProofKeyStore: ProofKeyStore {
    var service = Product.storagePrefix + "push-proof"
    var account = "p256"

    func read() -> Data? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    func write(_ data: Data) -> Bool {
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update: [String: Any] = [kSecValueData as String: data]
            return SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary) == errSecSuccess
        }
        return status == errSecSuccess
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

struct DeviceProof {
    /// The relay's prefix (packages/push-relay/src/relay.ts `PROOF_PREFIX`).
    static let prefix = "corehub-push-bind-v1"

    let store: ProofKeyStore

    /// This install's key: made the first time it is needed, the same one every time after.
    func key() -> P256.Signing.PrivateKey? {
        if let data = store.read(), let kept = try? P256.Signing.PrivateKey(rawRepresentation: data) {
            return kept
        }
        let fresh = P256.Signing.PrivateKey()
        return store.write(fresh.rawRepresentation) ? fresh : nil
    }

    /// What is signed: the prefix, the platform (`apns`), the token and the unix time, one a line.
    static func message(platform: String, token: String, signedAt: Int) -> Data {
        Data([prefix, platform, token, String(signedAt)].joined(separator: "\n").utf8)
    }

    /// The proof for one registration: the raw public point (65 bytes) and the raw `r || s`
    /// signature (64 bytes), both base64url. Nil when the key cannot be made or kept; the phone
    /// then registers without one, as an older app does.
    func proof(platform: String, token: String, now: Date = Date()) -> PushRelayProof? {
        guard let key = key() else { return nil }
        let signedAt = Int(now.timeIntervalSince1970)
        let message = Self.message(platform: platform, token: token, signedAt: signedAt)
        guard let signature = try? key.signature(for: message) else { return nil }
        return PushRelayProof(
            key: Self.base64url(key.publicKey.x963Representation),
            signedAt: signedAt,
            signature: Self.base64url(signature.rawRepresentation)
        )
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
