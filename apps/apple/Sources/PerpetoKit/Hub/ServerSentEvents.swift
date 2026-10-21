import Foundation

/// One dispatched server-sent event.
public struct ServerSentEvent: Equatable, Sendable {
    public var id: String?
    public var event: String?
    public var data: String
    public var retry: Int?
}

/// Incremental parser for `text/event-stream` lines (WHATWG HTML §9.2).
/// Feed it one line at a time without the trailing newline.
public struct ServerSentEventParser: Sendable {
    private var data: [String] = []
    private var event: String?
    private var id: String?
    private var retry: Int?

    public init() {}

    /// Returns an event when a blank line completes one.
    public mutating func feed(_ line: String) -> ServerSentEvent? {
        if line.isEmpty { return dispatch() }
        if line.hasPrefix(":") { return nil }

        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }

        switch field {
        case "data": data.append(String(value))
        case "event": event = String(value)
        case "id": if !value.contains("\0") { id = String(value) }
        case "retry": retry = Int(value)
        default: break
        }
        return nil
    }

    /// Flushes a trailing event when the stream ends without a blank line.
    public mutating func finish() -> ServerSentEvent? { dispatch() }

    private mutating func dispatch() -> ServerSentEvent? {
        defer {
            data = []
            event = nil
            retry = nil
        }
        guard !data.isEmpty else { return nil }
        return ServerSentEvent(id: id, event: event, data: data.joined(separator: "\n"), retry: retry)
    }
}
