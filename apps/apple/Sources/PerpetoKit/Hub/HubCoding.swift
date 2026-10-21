import Foundation

public enum HubCoding {
    /// Decoder for hub responses. Accepts ISO 8601 with or without fractional seconds.
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = parseDate(raw) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid ISO 8601 timestamp."))
        }
        return decoder
    }

    /// Encoder for request bodies. Writes ISO 8601 UTC with milliseconds.
    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
        }
        return encoder
    }

    public static func parseDate(_ raw: String) -> Date? {
        if let date = try? Date(raw, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
        return try? Date(raw, strategy: Date.ISO8601FormatStyle())
    }
}

/// Errors surfaced to the interface. Messages describe the affected operation
/// and never include tokens or raw response bodies.
public enum HubError: Error, Equatable, Sendable, LocalizedError {
    case notConfigured
    case invalidURL
    case insecureRemote
    case unauthorized
    case http(status: Int, code: String?, message: String?)
    case conflict(code: String?, message: String?)
    case transport(String)
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .notConfigured: "No hub is configured. Showing demo data."
        case .invalidURL: "The hub address is not a valid HTTP(S) URL."
        case .insecureRemote: "Remote hubs need HTTPS. Plain HTTP is allowed only for localhost."
        case .unauthorized: "The hub rejected the owner token. Update it in Settings."
        case .http(let status, _, let message): message ?? "The hub returned HTTP \(status)."
        case .conflict(_, let message): message ?? "The hub reported a conflict with newer state."
        case .transport: "The hub could not be reached. Check the address and that the hub is running."
        case .decoding: "The hub returned a response this app cannot read."
        }
    }
}

/// `{ "error": { "code": "SNAKE_CASE", "message": "…" } }`
struct ErrorEnvelope: Decodable {
    struct Body: Decodable {
        var code: String
        var message: String
    }
    var error: Body
}
