import Foundation
import Security

/// What the app and its extensions share (an App Group, and a Keychain group):
/// this device's message key and push token, what the web app last told the
/// native side (language, Communicator's address, the sources' names), so the
/// notification extension can show a message while the app is closed, and the
/// folder shared recordings wait in. The iPhone side of Android's Store.
enum Store {
    static let group = "group.ai.ivrit"
    static let defaultCommunicator = "https://communicator.ivrit.ai"

    static var defaults: UserDefaults { UserDefaults(suiteName: group) ?? .standard }

    static var container: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    // MARK: the message key

    private static let keyService = "ai.ivrit.push"
    private static let keyAccount = "key"

    /// The Keychain group the app and its notification extension share, from
    /// Info.plist ($(AppIdentifierPrefix)ai.ivrit.shared). Unsigned builds
    /// (the simulator in CI) have none, and keep the key to themselves.
    private static var keychainGroup: String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "IvritKeychainGroup") as? String,
              !group.hasPrefix("ai.ivrit") else { return nil }
        return group
    }

    private static func keyQuery(group: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keyService,
            kSecAttrAccount as String: keyAccount,
        ]
        if let group { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    /// The AES-256 key messages to this device are sealed with (see Sealed),
    /// made once by the app. The notification extension only reads it: nil
    /// there means the app has not registered yet.
    static func pushKey(create: Bool) -> Data? {
        for group in [keychainGroup, nil] {
            var query = keyQuery(group: group)
            query[kSecReturnData as String] = true
            var found: CFTypeRef?
            if SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data, data.count == 32 {
                return data
            }
            if keychainGroup == nil { break }
        }
        guard create else { return nil }
        var key = Data(count: 32)
        let made = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard made == errSecSuccess else { return nil }
        // After first unlock: messages arrive while the phone is locked.
        var add = keyQuery(group: keychainGroup)
        add[kSecValueData as String] = key
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecMissingEntitlement {
            add.removeValue(forKey: kSecAttrAccessGroup as String)
            status = SecItemAdd(add as CFDictionary, nil)
        }
        return status == errSecSuccess ? key : nil
    }

    static func pushKeyText() -> String? {
        pushKey(create: true).map(base64url)
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Remembers the current push token; returns the one it replaces, if any.
    static func swapToken(_ token: String) -> String? {
        let previous = defaults.string(forKey: "push_token")
        defaults.set(token, forKey: "push_token")
        return previous == nil || previous == token ? nil : previous
    }

    // MARK: what the web app said

    static func configure(locale: String?, communicator: String?, sources: [Any]?) {
        if let locale { defaults.set(locale, forKey: "locale") }
        if let communicator { defaults.set(communicator, forKey: "communicator") }
        if let sources, let data = try? JSONSerialization.data(withJSONObject: sources) {
            defaults.set(data, forKey: "sources")
        }
    }

    static var locale: String { defaults.string(forKey: "locale") ?? "he" }

    static var communicator: String { defaults.string(forKey: "communicator") ?? defaultCommunicator }

    /// A source's name in the app's language, as the web app shows it.
    static func sourceName(_ sourceId: String?, fallback: String) -> String {
        guard let sourceId,
              let data = defaults.data(forKey: "sources"),
              let sources = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              let source = sources.first(where: { $0["id"] as? String == sourceId }) else { return fallback }
        if locale == "he", let he = source["name_he"] as? String, !he.isEmpty { return he }
        return source["name"] as? String ?? fallback
    }
}
