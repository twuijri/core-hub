// One error type for everything the hub (or the way to it) can answer. Errors are never
// silent (TEAM-RULES §٤): `describe` gives a person one sentence, from the hub's own envelope
// `{ error, code }` when there is one.
import CoreHubClient
import Foundation

struct HubFailure: Error, Equatable {
    enum Kind: Equatable {
        /// The hub answered with an error status.
        case http
        /// The hub could not be reached.
        case connection
        /// The hub answered 2xx in a shape this app cannot read.
        case decode
        /// Not signed in.
        case signedOut
        case other
    }

    var kind: Kind
    var status: Int
    var code: String?
    /// The hub's sentence, already in the request language.
    var message: String?
    var operationID: String?
    var requestID: String?
    var detail: String

    static let signedOut = HubFailure(kind: .signedOut, status: 401, code: "unauthorized", message: nil, operationID: nil, requestID: nil, detail: "")

    init(kind: Kind, status: Int, code: String?, message: String?, operationID: String?, requestID: String?, detail: String) {
        self.kind = kind
        self.status = status
        self.code = code
        self.message = message
        self.operationID = operationID
        self.requestID = requestID
        self.detail = detail
    }

    init(_ error: Error) {
        self = HubFailure.from(error)
    }

    static func from(_ error: Error) -> HubFailure {
        if let failure = error as? HubFailure { return failure }
        if case let ErrorResponse.error(status, data, _, underlying) = error {
            let envelope = data.flatMap { try? JSONDecoder().decode(Envelope.self, from: $0) }
            let kind: Kind
            if status <= 0 || underlying is URLError {
                kind = .connection
            } else if (200..<300).contains(status) {
                kind = .decode
            } else {
                kind = .http
            }
            return HubFailure(
                kind: kind,
                status: status,
                code: envelope?.code,
                message: envelope?.error,
                operationID: envelope?.details?.operationId,
                requestID: envelope?.details?.request_id,
                detail: String(describing: underlying)
            )
        }
        if error is URLError {
            return HubFailure(kind: .connection, status: -1, code: nil, message: nil, operationID: nil, requestID: nil, detail: String(describing: error))
        }
        return HubFailure(kind: .other, status: 0, code: nil, message: nil, operationID: nil, requestID: nil, detail: String(describing: error))
    }

    /// The hub's error envelope (`Error` in the contract), read loosely: an unknown `code`
    /// must not hide the sentence.
    private struct Envelope: Decodable {
        struct Details: Decodable {
            let operationId: String?
            let request_id: String?
        }

        let error: String?
        let code: String?
        let details: Details?
    }

    func describe(_ l10n: L10n) -> String {
        switch kind {
        case .signedOut:
            return l10n("errors.signed_out")
        case .connection:
            return l10n("errors.connection")
        case .decode:
            return l10n("errors.decode", ["message": detail])
        case .http:
            if status == 501 { return l10n("errors.not_implemented", ["operation": operationID ?? "?"]) }
            if let message, !message.isEmpty {
                if status >= 500, let requestID { return "\(message) (\(requestID))" }
                return message
            }
            return l10n("errors.unexpected", ["message": "HTTP \(status)"])
        case .other:
            return l10n("errors.unexpected", ["message": detail])
        }
    }
}
