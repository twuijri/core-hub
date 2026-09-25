// HTTP goes through the Swift client generated from packages/contracts (CoreHubClient); this
// file only decides which hub, which bearer and which language a call carries, and refreshes
// an expired access token once (single flight) before trying again. No API path is typed here
// (`pnpm contracts:check-clients`): the generated client owns them, the base path included.
import CoreHubClient
import Foundation

/// Holds the credentials and refreshes them. An actor, so two requests that both find the
/// token expired share one refresh.
actor TokenKeeper {
    private(set) var credentials: Credentials?
    private var refreshing: Task<Bool, Never>?
    private let store: KeychainStore
    private var language: AppLanguage = .ar
    /// Called (on the main actor) when the hub refuses the refresh for good.
    private var signedOut: (@MainActor () -> Void)?

    init(store: KeychainStore = KeychainStore()) {
        self.store = store
        self.credentials = store.read()
    }

    func onSignedOut(_ handler: @escaping @MainActor () -> Void) { signedOut = handler }

    func setLanguage(_ language: AppLanguage) { self.language = language }

    func set(_ credentials: Credentials?) {
        self.credentials = credentials
        if let credentials { store.save(credentials) } else { store.clear() }
    }

    func update(_ change: (inout Credentials) -> Void) {
        guard var current = credentials else { return }
        change(&current)
        set(current)
    }

    /// Who the person is now (`auth.getMe`), kept with the tokens.
    func updateAccount(_ me: User) {
        update {
            $0.displayName = me.displayName
            $0.username = me.username
            $0.role = me.role.rawValue
            $0.profiles = me.profiles
            $0.defaultProfile = me.defaultProfile
        }
    }

    /// The bearer to send now, refreshed first when it is about to expire.
    func bearer() async -> String? {
        if let current = credentials, current.needsRefresh() { _ = await refresh() }
        return credentials?.accessToken
    }

    /// Trades the refresh token for a new access token, or renews a device's app token.
    /// True when the credentials now hold a working token.
    func refresh() async -> Bool {
        if let refreshing { return await refreshing.value }
        let task = Task { await self.performRefresh() }
        refreshing = task
        let result = await task.value
        refreshing = nil
        return result
    }

    private func performRefresh() async -> Bool {
        guard let current = credentials else { return false }
        do {
            switch current.kind {
            case .password:
                guard let refreshToken = current.refreshToken else { return false }
                let config = HubAPI.configuration(hub: current.hubURL, bearer: nil, language: language)
                let pair = try await AuthAPI.authRefresh(
                    refreshRequest: RefreshRequest(refreshToken: refreshToken),
                    apiConfiguration: config
                )
                update {
                    $0.accessToken = pair.accessToken
                    $0.refreshToken = pair.refreshToken ?? $0.refreshToken
                    $0.accessExpiresAt = Date().addingTimeInterval(TimeInterval(pair.expiresIn))
                }
            case .device:
                // The app token itself is the bearer; renewing it only moves its expiry.
                let config = HubAPI.configuration(hub: current.hubURL, bearer: current.accessToken, language: language)
                _ = try await AuthAPI.authRefresh(refreshRequest: nil, apiConfiguration: config)
                update { $0.renewedAt = Date() }
            }
            return true
        } catch {
            let failure = HubFailure(error)
            if failure.status == 401 || failure.status == 403 {
                set(nil)
                if let signedOut { await signedOut() }
            }
            return false
        }
    }
}

final class HubAPI: @unchecked Sendable {
    let keeper: TokenKeeper
    private let lock = NSLock()
    private var _language: AppLanguage = .ar

    init(keeper: TokenKeeper) {
        self.keeper = keeper
    }

    var language: AppLanguage {
        get { lock.lock(); defer { lock.unlock() }; return _language }
        set {
            lock.lock(); _language = newValue; lock.unlock()
            Task { await keeper.setLanguage(newValue) }
        }
    }

    /// Where every request of this client starts: the hub's origin plus the contract's base
    /// path, which the generated client declares.
    static func configuration(hub: URL, bearer: String?, language: AppLanguage) -> CoreHubClientAPIConfiguration {
        let basePath = hub.absoluteString + CoreHubClientAPIConfiguration().basePath
        var headers = ["Accept-Language": language.rawValue]
        if let bearer { headers["Authorization"] = "Bearer \(bearer)" }
        return CoreHubClientAPIConfiguration(
            basePath: basePath,
            customHeaders: headers,
            apiResponseQueue: HubAPI.responses,
            interceptor: BodilessRequests()
        )
    }

    private static let responses = DispatchQueue(label: "\(Product.id).api", qos: .userInitiated)

    /// A signed-in call: the current bearer, and one refresh-and-retry on `token_expired`.
    func call<T>(_ operation: (CoreHubClientAPIConfiguration) async throws -> T) async throws -> T {
        guard let hub = await keeper.credentials?.hubURL else { throw HubFailure.signedOut }
        let bearer = await keeper.bearer()
        do {
            return try await operation(HubAPI.configuration(hub: hub, bearer: bearer, language: language))
        } catch {
            let failure = HubFailure(error)
            guard failure.status == 401, failure.code == "token_expired" || failure.code == "unauthorized",
                  await keeper.refresh(), let fresh = await keeper.credentials else { throw failure }
            do {
                return try await operation(HubAPI.configuration(hub: fresh.hubURL, bearer: fresh.accessToken, language: language))
            } catch {
                throw HubFailure(error)
            }
        }
    }

    /// A call before anyone is signed in (meta, login, claiming a pairing).
    func anonymous<T>(hub: URL, _ operation: (CoreHubClientAPIConfiguration) async throws -> T) async throws -> T {
        do {
            return try await operation(HubAPI.configuration(hub: hub, bearer: nil, language: language))
        } catch {
            throw HubFailure(error)
        }
    }
}

/// The generated client marks every POST `Content-Type: application/json`, also one with no
/// body (`cancelRun`, renewing an app token). The hub refuses an empty JSON body, as it
/// should; a request with nothing to send says nothing about its type.
final class BodilessRequests: OpenAPIInterceptor {
    func intercept<T>(urlRequest: URLRequest, urlSession: URLSessionProtocol, requestBuilder: RequestBuilder<T>, completion: @escaping (Result<URLRequest, Error>) -> Void) {
        completion(.success(BodilessRequests.adjust(urlRequest)))
    }

    func retry<T>(urlRequest: URLRequest, urlSession: URLSessionProtocol, requestBuilder: RequestBuilder<T>, data: Data?, response: URLResponse?, error: Error, completion: @escaping (OpenAPIInterceptorRetry) -> Void) {
        completion(.dontRetry)
    }

    static func adjust(_ request: URLRequest) -> URLRequest {
        guard request.httpBody?.isEmpty ?? true, request.httpBodyStream == nil else { return request }
        var copy = request
        copy.setValue(nil, forHTTPHeaderField: "Content-Type")
        return copy
    }
}
