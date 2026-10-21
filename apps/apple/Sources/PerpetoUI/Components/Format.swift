import Foundation
import PerpetoKit

/// Number and time formatting for explicit, readable figures.
public enum Format {
    public static func tokens(_ value: Int) -> String { compact(Double(value)) }
    public static func tokens(_ value: Double?) -> String { value.map { compact($0) } ?? "n/a" }

    public static func compact(_ value: Double) -> String {
        let abs = Swift.abs(value)
        switch abs {
        case 1_000_000_000...: return trim(value / 1_000_000_000) + "B"
        case 1_000_000...: return trim(value / 1_000_000) + "M"
        case 10_000...: return String(format: "%.0fk", value / 1000)
        case 1_000...: return trim(value / 1000) + "k"
        default: return String(Int(value.rounded()))
        }
    }

    private static func trim(_ v: Double) -> String {
        let s = String(format: v >= 100 ? "%.0f" : "%.1f", v)
        return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
    }

    /// "38 min", "2.4 h", "45 s".
    /// Null percentiles mean nothing finished in the window.
    public static func duration(_ seconds: Double?) -> String {
        seconds.map { duration($0) } ?? "n/a"
    }

    public static func duration(_ seconds: Double) -> String {
        switch seconds {
        case ..<60: return "\(Int(seconds.rounded())) s"
        case ..<5400: return "\(Int((seconds / 60).rounded())) min"
        case ..<172_800: return trim(seconds / 3600) + " h"
        default: return trim(seconds / 86400) + " d"
        }
    }

    public static func rate(_ perHour: Double) -> String { trim(perHour) + "/h" }

    public static func percent(_ fraction: Double) -> String { "\(Int((fraction * 100).rounded()))%" }

    public static func relative(_ date: Date, now: Date = Date()) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 0 {
            return "in " + duration(-seconds)
        }
        if seconds < 45 { return "just now" }
        return duration(seconds) + " ago"
    }

    /// 24-hour clock time for logs, in the user's time zone.
    public static func clock(_ date: Date) -> String {
        date.formatted(Date.VerbatimFormatStyle(
            format: "\(hour: .twoDigits(clock: .twentyFourHour, hourCycle: .zeroBased)):\(minute: .twoDigits):\(second: .twoDigits)",
            timeZone: .current, calendar: .current))
    }

    public static func day(_ date: Date) -> String { date.formatted(.dateTime.month(.abbreviated).day()) }

    public static func shortSha(_ sha: String?) -> String { sha.map { String($0.prefix(7)) } ?? "—" }

    /// "#229" from a PR URL.
    public static func prNumber(_ url: String?) -> String {
        guard let url, let last = url.split(separator: "/").last, Int(last) != nil else { return url ?? "—" }
        return "#\(last)"
    }

    public static func repoName(_ url: String) -> String {
        url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "github.com/", with: "")
    }

    public static func provider(_ id: String) -> String {
        switch id {
        case "claudeAgent": "Claude"
        case "codex": "Codex"
        default: id
        }
    }

    public static func plural(_ count: Int, _ singular: String, _ pluralForm: String? = nil) -> String {
        "\(count) " + (count == 1 ? singular : (pluralForm ?? singular + "s"))
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// Words that differ between the Mac and iPhone or iPad.
enum Platform {
    #if os(macOS)
    static let device = "this Mac"
    static let isPhoneOrPad = false
    #else
    static let device = "this device"
    static let isPhoneOrPad = true
    #endif
}
