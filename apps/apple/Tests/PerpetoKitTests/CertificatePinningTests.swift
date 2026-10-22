import Foundation
import Security
import Testing
@testable import PerpetoKit

@Suite("Certificate pinning")
struct CertificatePinningTests {
    /// A self-signed ECDSA P-256 test certificate (CN=perpeto-test), DER, like the hub's.
    static let der = Data(base64Encoded: "MIICEjCCAbgCCQDCP9JX9Xa/lzAKBggqhkjOPQQDAjAXMRUwEwYDVQQDDAxwZXJwZXRvLXRlc3QwHhcNMjYxMDIyMDExOTUyWhcNMzYxMDE5MDExOTUyWjAXMRUwEwYDVQQDDAxwZXJwZXRvLXRlc3QwggFLMIIBAwYHKoZIzj0CATCB9wIBATAsBgcqhkjOPQEBAiEA/////wAAAAEAAAAAAAAAAAAAAAD///////////////8wWwQg/////wAAAAEAAAAAAAAAAAAAAAD///////////////wEIFrGNdiqOpPns+u9VXaYhrxlHQawzFOw9jvOPD4n0mBLAxUAxJ02CIbnBJNqZnjhE50mt4GffpAEQQRrF9Hy4SxCR/i85uVjpEDydwN9gS3rM6D0oTlF2JjClk/jQuL+Gn+bjufrSnwPnhYrzjNXazFezsu2QGg3v1H1AiEA/////wAAAAD//////////7zm+q2nF56E87nKwvxjJVECAQEDQgAEWctiHDMyY5EBgnj+RrHGjXllxRP+YmkQZ9BchUixkKmZl8vIq4D1v3d1GBZ2b0nuVQn32tbyiJunU3pAM/0KozAKBggqhkjOPQQDAgNIADBFAiBUIBZWDeN/IFe3ak94P9pl8t6zp8vojT4MEvaFWM+QbAIhAKE44yu7XIIqAbOqkKPSWGCgZ8wuyyakAy62vSzWx/6X")!
    /// `shasum -a 256` of the DER above, in the hub's format.
    static let fingerprint = "ec40b1c0d50f1f1991f27c15b1f018f46972fe722df7b6d54cb9a6513f237c1e"
    static let other = String(repeating: "ab", count: 32)

    @Test func normalisesTheFormatsPeoplePaste() {
        #expect(CertificateFingerprint.normalize(Self.fingerprint) == Self.fingerprint)
        #expect(CertificateFingerprint.normalize(Self.fingerprint.uppercased()) == Self.fingerprint)
        #expect(CertificateFingerprint.normalize("  \(Self.fingerprint)\n") == Self.fingerprint)
        #expect(CertificateFingerprint.normalize("EC:40:B1:C0:D5:0F:1F:19:91:F2:7C:15:B1:F0:18:F4:69:72:FE:72:2D:F7:B6:D5:4C:B9:A6:51:3F:23:7C:1E") == Self.fingerprint)
        #expect(CertificateFingerprint.normalize("SHA256 Fingerprint=EC:40:B1:C0:D5:0F:1F:19:91:F2:7C:15:B1:F0:18:F4:69:72:FE:72:2D:F7:B6:D5:4C:B9:A6:51:3F:23:7C:1E") == Self.fingerprint)
        #expect(CertificateFingerprint.normalize("sha256:\(Self.fingerprint)") == Self.fingerprint)
        #expect(CertificateFingerprint.normalize("ec40 b1c0 d50f 1f19 91f2 7c15 b1f0 18f4 6972 fe72 2df7 b6d5 4cb9 a651 3f23 7c1e") == Self.fingerprint)
    }

    @Test func rejectsWhatIsNotASHA256Fingerprint() {
        #expect(CertificateFingerprint.normalize("") == nil)
        #expect(CertificateFingerprint.normalize(String(Self.fingerprint.dropLast())) == nil)
        #expect(CertificateFingerprint.normalize(Self.fingerprint + "00") == nil)
        #expect(CertificateFingerprint.normalize(String(Self.fingerprint.dropLast()) + "g") == nil)
        #expect(CertificateFingerprint.normalize("pj1_eyJ1cmwiOiJodHRwczovL2h1YiJ9") == nil)
        // SHA-1 (40 hex) is not accepted.
        #expect(CertificateFingerprint.normalize(String(repeating: "a", count: 40)) == nil)
    }

    @Test func matchesTheLeafDER() throws {
        #expect(CertificateFingerprint.of(der: Self.der) == Self.fingerprint)
        #expect(CertificateFingerprint.matches(leafDER: Self.der, pins: [Self.fingerprint]))
        #expect(CertificateFingerprint.matches(leafDER: Self.der, pins: [Self.other, Self.fingerprint]))
        #expect(!CertificateFingerprint.matches(leafDER: Self.der, pins: [Self.other]))
        #expect(!CertificateFingerprint.matches(leafDER: Self.der, pins: []))
        var tampered = Self.der
        tampered[tampered.count - 1] ^= 0x01
        #expect(!CertificateFingerprint.matches(leafDER: tampered, pins: [Self.fingerprint]))
    }

    @Test func readsTheLeafFromAServerTrust() throws {
        let certificate = try #require(SecCertificateCreateWithData(nil, Self.der as CFData))
        var trust: SecTrust?
        #expect(SecTrustCreateWithCertificates(certificate, SecPolicyCreateSSL(true, "127.0.0.1" as CFString), &trust) == errSecSuccess)
        #expect(CertificateFingerprint.leaf(of: try #require(trust)) == Self.fingerprint)
    }

    @Test func followsOnlyAnAnnouncedRotation() {
        let next = Self.other
        let stranger = String(repeating: "cd", count: 32)
        let changes = Box()
        let pins = HubPins(pin: Self.fingerprint) { pin, next in changes.values.append("\(pin)|\(next ?? "")") }

        // A served certificate we don't trust cannot move the pin.
        pins.adopt(HubTLSStatus(enabled: true, fingerprint: stranger, next: stranger))
        #expect(pins.accepted == [Self.fingerprint])

        // Rotate: the next certificate is announced over the pinned connection.
        pins.adopt(HubTLSStatus(enabled: true, fingerprint: Self.fingerprint, next: next))
        #expect(pins.accepted == [Self.fingerprint, next])

        // Activate: the hub serves the next one; the old pin is dropped.
        pins.adopt(HubTLSStatus(enabled: true, fingerprint: next))
        #expect(pins.pin == next && pins.next == nil)
        #expect(changes.values == ["\(Self.fingerprint)|\(next)", "\(next)|"])

        pins.adopt(HubTLSStatus(enabled: false))
        #expect(pins.accepted == [next])
    }

    @Test func clientRejectsBadPins() throws {
        let https = URL(string: "https://hub.example.com")!
        #expect(throws: HubError.invalidFingerprint) { try HubClient(baseURL: https, token: "t", fingerprint: "nope") }
        #expect(throws: HubError.fingerprintNeedsHTTPS) { try HubClient(baseURL: URL(string: "http://127.0.0.1:4320")!, token: "t", fingerprint: Self.fingerprint) }
        #expect(try HubClient(baseURL: https, token: "t", fingerprint: "").pins == nil)
        #expect(try HubClient(baseURL: https, token: "t", fingerprint: Self.fingerprint.uppercased()).pins?.pin == Self.fingerprint)
        // Plain HTTP on localhost without a pin still works.
        #expect(try HubClient(baseURL: URL(string: "http://localhost:4320")!, token: "t", fingerprint: nil).pins == nil)
    }

    @Test func settingsStoreTheNormalisedPin() throws {
        let suite = "perpeto.tests.pin.\(UUID().uuidString)"
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let settings = HubSettings(defaultsSuite: suite, tokens: KeychainTokenStore(service: "app.perpeto.tests.\(UUID().uuidString)"))
        try settings.setFingerprint("EC:40:B1:C0:D5:0F:1F:19:91:F2:7C:15:B1:F0:18:F4:69:72:FE:72:2D:F7:B6:D5:4C:B9:A6:51:3F:23:7C:1E")
        #expect(settings.fingerprint == Self.fingerprint)
        settings.storePins(pin: Self.fingerprint, next: Self.other)
        #expect(settings.nextFingerprint == Self.other)
        #expect(throws: HubError.invalidFingerprint) { try settings.setFingerprint("bad") }
        #expect(settings.fingerprint == Self.fingerprint)
        try settings.setFingerprint("")
        #expect(settings.fingerprint.isEmpty && settings.nextFingerprint == nil)
    }
}

private final class Box: @unchecked Sendable {
    var values: [String] = []
}

/// Runs against a hub serving HTTPS only when `PERPETO_TLS_HUB_URL`,
/// `PERPETO_TLS_HUB_FINGERPRINT` and `PERPETO_TLS_HUB_TOKEN_FILE` are set.
@Suite("Live pinned hub", .serialized, .enabled(if: ProcessInfo.processInfo.environment["PERPETO_TLS_HUB_URL"] != nil))
struct LivePinnedHubTests {
    let env = ProcessInfo.processInfo.environment
    var url: URL { URL(string: env["PERPETO_TLS_HUB_URL"]!)! }
    var token: String {
        get throws { try String(contentsOfFile: env["PERPETO_TLS_HUB_TOKEN_FILE"]!, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    @Test func pinnedConnectionSucceeds() async throws {
        let client = try HubClient(baseURL: url, token: try token, fingerprint: env["PERPETO_TLS_HUB_FINGERPRINT"]!)
        _ = try await client.accounts()
        let tls = try await client.tlsStatus()
        #expect(tls.enabled && tls.fingerprint == client.pins?.pin)
        // The SSE stream goes through the same pinned transport.
        var request = try client.makeRequest("GET", "/events")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let (_, response) = try await URLSessionTransport(pins: try #require(client.pins)).stream(request)
        #expect(response.statusCode == 200)
    }

    @Test func wrongPinFails() async throws {
        let client = try HubClient(baseURL: url, token: try token, fingerprint: String(repeating: "ab", count: 32))
        await #expect(throws: HubError.certificateMismatch) { _ = try await client.accounts() }
        var events = client.eventStream(after: nil).makeAsyncIterator()
        await #expect(throws: HubError.certificateMismatch) { _ = try await events.next() }
    }

    @Test func noPinUsesSystemValidation() async throws {
        let client = try HubClient(baseURL: url, token: try token)
        await #expect(throws: HubError.untrustedCertificate) { _ = try await client.accounts() }
    }

    /// Runs last: rotates the hub's certificate, so it needs `PERPETO_TLS_HUB_ALLOW_ROTATE=1`; use a throwaway hub.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["PERPETO_TLS_HUB_ALLOW_ROTATE"] == "1"))
    func followsARotation() async throws {
        let changes = Box()
        let client = try HubClient(baseURL: url, token: try token, fingerprint: env["PERPETO_TLS_HUB_FINGERPRINT"]!) { pin, next in
            changes.values.append("\(pin)|\(next ?? "")")
        }
        let pins = try #require(client.pins)
        let original = pins.pin
        let transport = URLSessionTransport(pins: pins)
        func post(_ path: String) async throws {
            var request = try client.makeRequest("POST", path)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{\"idempotencyKey\":\"\(UUID().uuidString)\"}".utf8)
            let (_, response) = try await transport.send(request)
            #expect((200..<300).contains(response.statusCode), "\(path) returned \(response.statusCode)")
        }
        try await post("/tls/rotate")
        await client.followCertificateRotation()
        let next = try #require(pins.next)
        try await post("/tls/activate")
        // A fresh pinned client with only the original pin is now refused; the one that followed still connects.
        let stale = try HubClient(baseURL: url, token: try token, fingerprint: original)
        await #expect(throws: HubError.certificateMismatch) { _ = try await stale.accounts() }
        _ = try await client.accounts()
        await client.followCertificateRotation()
        #expect(pins.pin == next && pins.next == nil)
        #expect(changes.values == ["\(original)|\(next)", "\(next)|"])
    }
}
