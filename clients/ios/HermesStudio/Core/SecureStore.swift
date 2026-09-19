import Foundation
import Security

enum SecureStore {
    private static let service = "us.i3u.hermesstudio.ios"

    static func set(_ value: String, for key: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(query as CFDictionary)
        var insert = query; insert[kSecValueData as String] = data; insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(insert as CFDictionary, nil)
    }

    static func get(_ key: String) -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    static func remove(_ key: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(query as CFDictionary)
    }
}

enum Preferences {
    static var baseURL: String {
        get { UserDefaults.standard.string(forKey: "baseURL") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "baseURL") }
    }
    static var profile: String {
        get { UserDefaults.standard.string(forKey: "profile") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "profile") }
    }
    static var language: String {
        get { UserDefaults.standard.string(forKey: "language") ?? "system" }
        set { UserDefaults.standard.set(newValue, forKey: "language") }
    }
    static var appearance: String {
        get { UserDefaults.standard.string(forKey: "appearance") ?? "system" }
        set { UserDefaults.standard.set(newValue, forKey: "appearance") }
    }
    /// Default model id for new conversations (drawer footer model selector).
    static var preferredModel: String {
        get { UserDefaults.standard.string(forKey: "preferredModel") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "preferredModel") }
    }
    static var reasoningEffort: String {
        get { UserDefaults.standard.string(forKey: "reasoningEffort") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "reasoningEffort") }
    }
    /// Where spoken input is transcribed: `device` (Apple Speech, default) or
    /// `server` (Core Hub `/api/studio/stt/transcribe`).
    static let voiceInputDevice = "device"
    static let voiceInputServer = "server"
    static var voiceInput: String {
        get { UserDefaults.standard.string(forKey: "voiceInput") ?? voiceInputDevice }
        set { UserDefaults.standard.set(newValue, forKey: "voiceInput") }
    }
    /// Composer ⚙ settings shared with the web: tool-call trace visibility and
    /// "Voice mode" (speak every assistant reply automatically).
    static var showToolCalls: Bool {
        get { UserDefaults.standard.object(forKey: "showToolCalls") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "showToolCalls") }
    }
    static var autoSpeakReplies: Bool {
        get { UserDefaults.standard.bool(forKey: "autoSpeakReplies") }
        set { UserDefaults.standard.set(newValue, forKey: "autoSpeakReplies") }
    }
    /// Session lists show every profile (web "All profiles") instead of the
    /// selected one.
    static var allProfilesSessions: Bool {
        get { UserDefaults.standard.bool(forKey: "allProfilesSessions") }
        set { UserDefaults.standard.set(newValue, forKey: "allProfilesSessions") }
    }
    /// Local text scale (web font size 12–20 → 0.85…1.45 multiplier).
    static var textScale: Double {
        get { let value = UserDefaults.standard.double(forKey: "textScale"); return value > 0 ? value : 1 }
        set { UserDefaults.standard.set(newValue, forKey: "textScale") }
    }
    /// Voice that speaks the assistant's reply, stored per profile:
    /// `device` for this iPhone's voice, a Studio provider id for a server
    /// voice, empty until the owner picks one — which means "follow the
    /// profile's active provider", the same default as the web client.
    static func ttsVoice(for profile: String) -> String {
        UserDefaults.standard.string(forKey: "ttsVoice.\(profile)") ?? ""
    }
    static func setTtsVoice(_ value: String, profile: String) {
        UserDefaults.standard.set(value, forKey: "ttsVoice.\(profile)")
    }

    /// Which language dictation listens for, stored per profile like the
    /// spoken-reply voice: empty means "follow my keyboard languages" (the
    /// default), `app` means the app language, `server` means Core Hub
    /// detection, anything else is a BCP-47 identifier the recogniser supports.
    static func speechLanguage(for profile: String) -> String {
        UserDefaults.standard.string(forKey: "speechLanguage.\(profile)") ?? ""
    }
    static func setSpeechLanguage(_ value: String, profile: String) {
        UserDefaults.standard.set(value, forKey: "speechLanguage.\(profile)")
    }
    /// The last dictation languages picked for this profile, most recent first.
    static func recentSpeechLanguages(for profile: String) -> [String] {
        UserDefaults.standard.stringArray(forKey: "speechLanguageRecent.\(profile)") ?? []
    }
    static func setRecentSpeechLanguages(_ value: [String], profile: String) {
        UserDefaults.standard.set(value, forKey: "speechLanguageRecent.\(profile)")
    }
    /// How many dictations this profile has started, and whether the mic's
    /// long press has ever been used. Together they decide the occasional
    /// hint above the composer (`DictationHintPolicy`). Counting only, no
    /// timestamps and nothing leaves the device.
    static func dictationCount(for profile: String) -> Int {
        UserDefaults.standard.integer(forKey: "dictationCount.\(profile)")
    }
    static func setDictationCount(_ value: Int, profile: String) {
        UserDefaults.standard.set(value, forKey: "dictationCount.\(profile)")
    }
    static func dictationLongPressUsed(for profile: String) -> Bool {
        UserDefaults.standard.bool(forKey: "dictationLongPressUsed.\(profile)")
    }
    static func setDictationLongPressUsed(_ value: Bool, profile: String) {
        UserDefaults.standard.set(value, forKey: "dictationLongPressUsed.\(profile)")
    }

    static func session(for profile: String) -> String { UserDefaults.standard.string(forKey: "session.\(profile)") ?? "" }
    static func setSession(_ id: String, profile: String) { UserDefaults.standard.set(id, forKey: "session.\(profile)") }
}
