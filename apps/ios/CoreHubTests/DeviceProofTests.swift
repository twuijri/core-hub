@testable import CoreHub
import CoreHubClient
import CryptoKit
import Foundation
import XCTest

/// A Keychain, played: what was written, and whether it keeps anything at all.
private final class MemoryProofStore: ProofKeyStore {
    var data: Data?
    var keeps = true
    private(set) var writes = 0

    func read() -> Data? { data }

    func write(_ data: Data) -> Bool {
        writes += 1
        guard keeps else { return false }
        self.data = data
        return true
    }
}

final class DeviceProofTests: XCTestCase {
    private func bytes(_ base64url: String) -> Data? {
        var text = base64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while text.count % 4 != 0 { text += "=" }
        return Data(base64Encoded: text)
    }

    func testTheKeyIsMadeOnceAndKept() {
        let store = MemoryProofStore()
        let proofs = DeviceProof(store: store)
        let first = proofs.key()
        let again = proofs.key()
        XCTAssertNotNil(first)
        XCTAssertEqual(first?.publicKey.rawRepresentation, again?.publicKey.rawRepresentation)
        XCTAssertEqual(store.writes, 1)
        // Another launch reads the same key back from the store.
        XCTAssertEqual(DeviceProof(store: store).key()?.publicKey.rawRepresentation, first?.publicKey.rawRepresentation)
    }

    func testTheProofIsWhatTheRelayVerifies() throws {
        let proofs = DeviceProof(store: MemoryProofStore())
        let token = String(repeating: "ab", count: 32)
        let now = Date(timeIntervalSince1970: 1_790_000_123.9)
        let proof = try XCTUnwrap(proofs.proof(platform: "apns", token: token, now: now))
        XCTAssertEqual(proof.signedAt, 1_790_000_123)

        // The raw uncompressed point and the raw r || s, base64url without padding.
        let key = try XCTUnwrap(bytes(proof.key))
        let signature = try XCTUnwrap(bytes(proof.signature))
        XCTAssertEqual(key.count, 65)
        XCTAssertEqual(key.first, 0x04)
        XCTAssertEqual(signature.count, 64)
        for text in [proof.key, proof.signature] {
            XCTAssertNil(text.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
        }

        let message = Data("corehub-push-bind-v1\napns\n\(token)\n1790000123".utf8)
        XCTAssertEqual(DeviceProof.message(platform: "apns", token: token, signedAt: 1_790_000_123), message)
        let publicKey = try P256.Signing.PublicKey(x963Representation: key)
        let ecdsa = try P256.Signing.ECDSASignature(rawRepresentation: signature)
        XCTAssertTrue(publicKey.isValidSignature(ecdsa, for: message))
        // Another token or another time does not verify with it.
        XCTAssertFalse(publicKey.isValidSignature(ecdsa, for: DeviceProof.message(platform: "apns", token: token, signedAt: 1_790_000_124)))
        XCTAssertFalse(publicKey.isValidSignature(ecdsa, for: DeviceProof.message(platform: "fcm", token: token, signedAt: 1_790_000_123)))
    }

    func testEveryProofOfThisInstallHasTheSameKey() throws {
        let proofs = DeviceProof(store: MemoryProofStore())
        let first = try XCTUnwrap(proofs.proof(platform: "apns", token: "aa", now: Date(timeIntervalSince1970: 100)))
        let later = try XCTUnwrap(proofs.proof(platform: "apns", token: "bb", now: Date(timeIntervalSince1970: 200)))
        XCTAssertEqual(first.key, later.key)
        XCTAssertGreaterThan(later.signedAt, first.signedAt)
    }

    func testNoProofWhenTheKeyCannotBeKept() {
        let store = MemoryProofStore()
        store.keeps = false
        XCTAssertNil(DeviceProof(store: store).proof(platform: "apns", token: "aa"))
    }

    func testBase64url() {
        XCTAssertEqual(DeviceProof.base64url(Data([0xfb, 0xff, 0xfe])), "-__-")
        XCTAssertEqual(DeviceProof.base64url(Data([1, 2, 3, 255])), "AQID_w")
    }
}
