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
    /// SHA-256 fingerprint of a self-signed hub certificate, normalised. Not secret.
    public static let fingerprintKey = "perpeto.hubFingerprint"
    /// The next certificate the pinned hub announced during a rotation.
    public static let nextFingerprintKey = "perpeto.hubFingerprintNext"

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

    /// The pinned certificate fingerprint, or "" for system validation.
    public var fingerprint: String { defaults.string(forKey: Self.fingerprintKey) ?? "" }
    public var nextFingerprint: String? { defaults.string(forKey: Self.nextFingerprintKey) }

    /// Stores the fingerprint normalised (empty removes the pin). A changed
    /// pin drops any learned rotation. Throws for anything that isn't a
    /// SHA-256 fingerprint, leaving the stored value unchanged.
    public func setFingerprint(_ value: String) throws {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            defaults.removeObject(forKey: Self.fingerprintKey)
            defaults.removeObject(forKey: Self.nextFingerprintKey)
            return
        }
        guard let pin = CertificateFingerprint.normalize(trimmed) else { throw HubError.invalidFingerprint }
        if pin != fingerprint { defaults.removeObject(forKey: Self.nextFingerprintKey) }
        defaults.set(pin, forKey: Self.fingerprintKey)
    }

    /// Persists a rotation learned over the pinned connection.
    public func storePins(pin: String, next: String?) {
        defaults.set(pin, forKey: Self.fingerprintKey)
        if let next { defaults.set(next, forKey: Self.nextFingerprintKey) } else { defaults.removeObject(forKey: Self.nextFingerprintKey) }
    }

    /// A client for `url` and `token`, pinned to `fingerprint` when one is
    /// given. The learned next fingerprint applies only to the stored pin.
    public func client(url: URL, token: String, fingerprint: String) throws -> HubClient {
        let normalized = CertificateFingerprint.normalize(fingerprint)
        let next = normalized != nil && normalized == CertificateFingerprint.normalize(self.fingerprint) ? nextFingerprint : nil
        let suite = defaultsSuite
        return try HubClient(baseURL: url, token: token, fingerprint: fingerprint, next: next) { pin, next in
            HubSettings(defaultsSuite: suite).storePins(pin: pin, next: next)
        }
    }

    /// A client when both a URL and a token are present; otherwise nil (demo data).
    public func makeClient() throws -> HubClient? {
        guard let url = hubURL else { return nil }
        guard let token = tokens.read(), !token.isEmpty else { return nil }
        return try client(url: url, token: token, fingerprint: fingerprint)
    }
}
