import Foundation

/// A friendly form of the hub's five-field numeric UTC cron.
public struct ScheduleRule: Equatable, Sendable {
    public enum Frequency: String, CaseIterable, Hashable, Sendable {
        case hourly, daily, weekdays, weekly
        public var title: String {
            switch self {
            case .hourly: "Every hour"
            case .daily: "Every day"
            case .weekdays: "Weekdays"
            case .weekly: "Once a week"
            }
        }
    }

    public var frequency: Frequency = .weekdays
    public var hour = 9
    public var minute = 0
    /// Cron weekday, 0 is Sunday.
    public var weekday = 1
    /// A cron this form cannot show; kept as is.
    public var custom: String?

    public init(frequency: Frequency = .weekdays, hour: Int = 9, minute: Int = 0, weekday: Int = 1) {
        self.frequency = frequency
        self.hour = hour
        self.minute = minute
        self.weekday = weekday
    }

    public init(cron: String) {
        let f = cron.split(separator: " ").map(String.init)
        guard f.count == 5, let m = Int(f[0]), f[2] == "*", f[3] == "*" else { custom = cron; return }
        minute = m
        if f[1] == "*", f[4] == "*" { frequency = .hourly; return }
        guard let h = Int(f[1]) else { custom = cron; return }
        hour = h
        switch f[4] {
        case "*": frequency = .daily
        case "1-5": frequency = .weekdays
        default:
            guard let d = Int(f[4]), (0...6).contains(d) else { custom = cron; return }
            frequency = .weekly
            weekday = d
        }
    }

    public var cron: String {
        if let custom { return custom }
        switch frequency {
        case .hourly: return "\(minute) * * * *"
        case .daily: return "\(minute) \(hour) * * *"
        case .weekdays: return "\(minute) \(hour) * * 1-5"
        case .weekly: return "\(minute) \(hour) * * \(weekday)"
        }
    }

    public static let dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    public var summary: String {
        if let custom { return "cron \(custom) UTC" }
        let time = String(format: "%02d:%02d UTC", hour, minute)
        switch frequency {
        case .hourly: return String(format: "every hour at :%02d", minute)
        case .daily: return "every day at \(time)"
        case .weekdays: return "weekdays at \(time)"
        case .weekly: return "\(Self.dayNames[weekday])s at \(time)"
        }
    }
}

