import CryptoKit
import Foundation
import Security

/// SHA-256 certificate fingerprints in the hub's format: 64 lowercase hex
/// characters of the DER (`fingerprintOf` in apps/hub/src/tls.js, printed by
/// `perpeto hub init --tls` and `perpeto hub tls status`).
public enum CertificateFingerprint {
    /// Accepts the hub's form and the common variants people paste: colons,
    /// spaces, upper case, a `sha256:` prefix or openssl's
    /// `sha256 Fingerprint=AB:CD:…`. Nil when it isn't a SHA-256 fingerprint.
    public static func normalize(_ raw: String) -> String? {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let equals = value.lastIndex(of: "=") { value = String(value[value.index(after: equals)...]) }
        for prefix in ["sha256:", "sha-256:", "sha256 "] where value.hasPrefix(prefix) { value = String(value.dropFirst(prefix.count)) }
        value.removeAll { $0 == ":" || $0 == " " || $0 == "-" || $0 == "\t" }
        guard value.count == 64, value.allSatisfy({ $0.isHexDigit && $0.isASCII }) else { return nil }
        return value
    }

    /// The fingerprint of a DER-encoded certificate.
    public static func of(der: Data) -> String {
        SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }

    /// The fingerprint of the leaf certificate a server presented.
    public static func leaf(of trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        return of(der: SecCertificateCopyData(leaf) as Data)
    }

    /// True only when the leaf's fingerprint is one of `pins`. An empty pin
    /// set matches nothing.
    public static func matches(leafDER: Data, pins: Set<String>) -> Bool {
        !pins.isEmpty && pins.contains(of(der: leafDER))
    }
}

/// The fingerprints a pinned hub connection accepts: the one the owner
/// entered, plus the `next` certificate the hub announced over an already
/// pinned connection during a rotation. Thread-safe; shared by every request.
public final class HubPins: @unchecked Sendable {
    private let lock = NSLock()
    private var current: String
    private var upcoming: String?
    /// Called when a rotation changes what is accepted, to persist it.
    private let onChange: @Sendable (_ pin: String, _ next: String?) -> Void

    public init(pin: String, next: String? = nil, onChange: @escaping @Sendable (_ pin: String, _ next: String?) -> Void = { _, _ in }) {
        self.current = pin
        self.upcoming = next == pin ? nil : next
        self.onChange = onChange
    }

    public var pin: String { lock.withLock { current } }
    public var next: String? { lock.withLock { upcoming } }
    public var accepted: Set<String> { lock.withLock { Set([current] + (upcoming.map { [$0] } ?? [])) } }

    /// Adopts `GET /tls` from a connection this set already authenticated.
    /// The served certificate must be one we accept, so a response can only
    /// move the pin forward along a rotation the hub announced, never to an
    /// unrelated certificate.
    public func adopt(_ status: HubTLSStatus) {
        guard status.enabled, let served = status.fingerprint.flatMap(CertificateFingerprint.normalize) else { return }
        let announced = status.next.flatMap(CertificateFingerprint.normalize)
        let changed: (String, String?)? = lock.withLock {
            guard served == current || served == upcoming else { return nil }
            let next = announced == served ? nil : announced
            guard served != current || next != upcoming else { return nil }
            current = served
            upcoming = next
            return (served, next)
        }
        if let changed { onChange(changed.0, changed.1) }
    }
}

/// `GET /tls`.
public struct HubTLSStatus: Decodable, Sendable, Equatable {
    public var enabled: Bool
    public var fingerprint: String?
    public var expiresAt: String?
    public var next: String?

    public init(enabled: Bool, fingerprint: String? = nil, expiresAt: String? = nil, next: String? = nil) {
        self.enabled = enabled
        self.fingerprint = fingerprint
        self.expiresAt = expiresAt
        self.next = next
    }
}

/// Per-task delegate that trusts exactly the pinned certificates, the same
/// rule as the node's transport (apps/node/src/transport.js). The pin is the
/// trust anchor, so a self-signed hub certificate is accepted only when its
/// leaf matches; on a mismatch the challenge is cancelled and the request
/// fails. Other challenges get default handling.
final class PinningTaskDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let pins: HubPins
    private let host: String?
    private let lock = NSLock()
    private var presented: String?
    private var mismatched = false

    init(pins: HubPins, host: String?) {
        self.pins = pins
        self.host = host
    }

    /// The fingerprint of a certificate that was refused, if any.
    var rejectedFingerprint: String? { lock.withLock { mismatched ? presented : nil } }
    var rejected: Bool { lock.withLock { mismatched } }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let fingerprint = CertificateFingerprint.leaf(of: trust)
        let accepted = (host == nil || space.host.caseInsensitiveCompare(host!) == .orderedSame)
            && fingerprint.map { pins.accepted.contains($0) } == true
        lock.withLock {
            presented = fingerprint
            mismatched = !accepted
        }
        if accepted {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
