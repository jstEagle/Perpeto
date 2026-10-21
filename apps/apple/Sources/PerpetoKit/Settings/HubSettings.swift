import Foundation
import Security

/// Stores the owner token in the login Keychain. The token never goes to
/// UserDefaults, logs or error messages.
public struct KeychainTokenStore: Sendable {
    public let service: String
    public let account: String

    public init(service: String = "app.perpeto.hub", account: String = "owner-token") {
        self.service = service
        self.account = account
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func read() -> String? {
        var query = self.query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    public func write(_ token: String) -> Bool {
        let data = Data(token.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    public func delete() -> Bool {
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

/// Non-secret connection settings in UserDefaults.
public struct HubSettings: Sendable {
    public static let hubURLKey = "perpeto.hubURL"

    private let defaultsSuite: String?
    public let tokens: KeychainTokenStore

    public init(defaultsSuite: String? = nil, tokens: KeychainTokenStore = KeychainTokenStore()) {
        self.defaultsSuite = defaultsSuite
        self.tokens = tokens
    }

    private var defaults: UserDefaults { defaultsSuite.flatMap(UserDefaults.init(suiteName:)) ?? .standard }

    public var hubURL: URL? {
        guard let raw = defaults.string(forKey: Self.hubURLKey)?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    public var hubURLString: String { defaults.string(forKey: Self.hubURLKey) ?? "" }

    public func setHubURL(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { defaults.removeObject(forKey: Self.hubURLKey) } else { defaults.set(trimmed, forKey: Self.hubURLKey) }
    }

    /// A client when both a URL and a token are present; otherwise nil (demo data).
    public func makeClient() throws -> HubClient? {
        guard let url = hubURL else { return nil }
        guard let token = tokens.read(), !token.isEmpty else { return nil }
        return try HubClient(baseURL: url, token: token)
    }
}
