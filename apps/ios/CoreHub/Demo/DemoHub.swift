// A hub inside the app, for the App Store screenshots and UI tests only (docs/store/apple/README.md).
// Launched with `-UITestDemo YES`, the app is signed in to it at once and every request of the
// generated client is answered from `DemoFixtures` (apps/ios/scripts/demo-fixtures.mjs, checked
// against the contract). Nothing leaves the phone: no network, no socket, no push, no notices.
// Debug builds only — an App Store (Release) build carries none of this.
//
//   -UITestDemo YES             sign in to the demo hub
//   -UITestDemoOpen /tasks      open a page, as a `corehub://open/<path>` link would
//   -corehub.language ar        the app's language (and `-corehub.theme dark` its theme)
#if DEBUG
import CoreHubClient
import Foundation

enum DemoHub {
    static var isOn: Bool { UserDefaults.standard.bool(forKey: "UITestDemo") }

    /// The page to open once signed in, as a path of `surfaceRoutes.ios`.
    static var openPath: String? { UserDefaults.standard.string(forKey: "UITestDemoOpen") }

    /// Never resolved: every request is answered before it would reach the network.
    static let hubURL = URL(string: "https://demo.\(Product.id).invalid")!

    /// Its own Keychain item, so the demo never touches a real sign-in on the same phone.
    static let keychainService = Product.storagePrefix + "demo-credentials"

    static let factory = DemoRequestBuilderFactory()

    static func credentials() -> Credentials {
        Credentials(
            hubURL: hubURL,
            kind: .device,
            accessToken: "demo",
            refreshToken: nil,
            accessExpiresAt: nil,
            renewedAt: Date(),
            userID: "",
            username: "sara",
            displayName: "",
            role: Role.owner.rawValue,
            profiles: ["work", "personal"],
            defaultProfile: "work"
        )
    }

    /// The status and JSON body for one request of the generated client.
    static func answer(_ request: URLRequest) -> (status: Int, body: Data) {
        let method = request.httpMethod ?? "GET"
        var path = request.url?.path ?? ""
        let base = CoreHubClientAPIConfiguration().basePath
        if path.hasPrefix(base) { path.removeFirst(base.count) }
        let language = request.value(forHTTPHeaderField: "Accept-Language") == AppLanguage.ar.rawValue ? "ar" : "en"
        for route in DemoFixtures.routes where route.method == method {
            guard let regex = try? NSRegularExpression(pattern: route.pattern),
                  let match = regex.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) else { continue }
            var parameter: String?
            if match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: path) {
                parameter = String(path[range])
            }
            let keys = [parameter.map { "\(language) \(route.operation) \($0)" }, "\(language) \(route.operation)"]
            for key in keys.compactMap({ $0 }) {
                if let json = DemoFixtures.answers[key] { return (200, Data(json.utf8)) }
            }
        }
        NSLog("[demo hub] no answer for %@ %@", method, path)
        let refusal = #"{"error":"Not in the demo hub.","code":"not_found"}"#
        return (404, Data(refusal.utf8))
    }
}

/// Builders of the generated client that ask `DemoSession` instead of `URLSession`.
final class DemoRequestBuilderFactory: RequestBuilderFactory {
    func getNonDecodableBuilder<T>() -> RequestBuilder<T>.Type { DemoRequestBuilder<T>.self }
    func getBuilder<T: Decodable>() -> RequestBuilder<T>.Type { DemoDecodableRequestBuilder<T>.self }
}

final class DemoRequestBuilder<T>: URLSessionRequestBuilder<T>, @unchecked Sendable {
    override func createURLSession() -> URLSessionProtocol { DemoSession.shared }
}

final class DemoDecodableRequestBuilder<T: Decodable>: URLSessionDecodableRequestBuilder<T>, @unchecked Sendable {
    override func createURLSession() -> URLSessionProtocol { DemoSession.shared }
}

final class DemoSession: URLSessionProtocol, @unchecked Sendable {
    static let shared = DemoSession()

    func dataTaskFromProtocol(
        with request: URLRequest,
        completionHandler: @escaping @Sendable (Data?, URLResponse?, (any Error)?) -> Void
    ) -> URLSessionDataTaskProtocol {
        DemoTask {
            let answer = DemoHub.answer(request)
            let response = HTTPURLResponse(
                url: request.url ?? DemoHub.hubURL,
                statusCode: answer.status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )
            completionHandler(answer.body, response, nil)
        }
    }
}

final class DemoTask: URLSessionDataTaskProtocol, @unchecked Sendable {
    private static let counter = NSLock()
    private static var next = 1

    let taskIdentifier: Int
    let progress = Progress(totalUnitCount: 1)
    private let run: @Sendable () -> Void

    init(_ run: @escaping @Sendable () -> Void) {
        self.run = run
        DemoTask.counter.lock()
        taskIdentifier = DemoTask.next
        DemoTask.next += 1
        DemoTask.counter.unlock()
    }

    /// A short pause, as a hub on the same network would take.
    func resume() {
        let run = run
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.05) { run() }
    }

    func cancel() {}
}
#endif
