import PerpetoKit
import SwiftUI

/// Semantic tone for status labels. Every tone is always paired with text.
public enum StatusTone: Sendable {
    case neutral, running, success, warning, error

    var color: Color {
        switch self {
        case .neutral: PerpetoColor.muted
        case .running: PerpetoColor.action
        case .success: PerpetoColor.success
        case .warning: PerpetoColor.warning
        case .error: PerpetoColor.error
        }
    }

    /// The dot uses the brighter signal orange for running work; it is
    /// decorative, while the label text uses the darker action token.
    var dot: Color { self == .running ? PerpetoColor.accent : color }
}

/// Explicit status label: a small dot and a word, never color alone.
public struct StatusLabel: View {
    var text: String
    var tone: StatusTone

    public init(_ text: String, tone: StatusTone) {
        self.text = text
        self.tone = tone
    }

    public var body: some View {
        HStack(spacing: PerpetoSpacing.x(1.5)) {
            Circle().fill(tone.dot).frame(width: 6, height: 6)
            Text(text)
                .font(PerpetoFont.captionMedium)
                .foregroundStyle(tone == .neutral ? PerpetoColor.muted : tone.color)
                .lineLimit(1)
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

/// Bordered tag, used for change kinds and labels.
public struct Tag: View {
    var text: String
    var color: Color
    var systemImage: String?

    public init(_ text: String, color: Color = PerpetoColor.muted, systemImage: String? = nil) {
        self.text = text
        self.color = color
        self.systemImage = systemImage
    }

    public var body: some View {
        HStack(spacing: PerpetoSpacing.x(1)) {
            if let systemImage { Image(systemName: systemImage).font(.system(size: 10, weight: .semibold)) }
            Text(text).font(PerpetoFont.captionMedium).lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.horizontal, PerpetoSpacing.x(1.5))
        .padding(.vertical, 2)
        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(color.opacity(0.55)))
        .fixedSize()
    }
}

// MARK: Status mapping

extension Run.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .running: ("Running", .running)
        case .paused: ("Paused", .warning)
        case .stopped: ("Stopped", .neutral)
        case .completed: ("Completed", .success)
        case .failed: ("Failed", .error)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension WorkItem.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .queued: ("Queued", .neutral)
        case .active: ("Active", .running)
        case .blocked: ("Blocked", .warning)
        case .done: ("Done", .success)
        case .failed: ("Failed", .error)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension Assignment.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .queued: ("Queued", .neutral)
        case .leased: ("Leased", .running)
        case .running: ("Running", .running)
        case .succeeded: ("Succeeded", .success)
        case .failed: ("Failed", .error)
        case .cancelled: ("Cancelled", .neutral)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension MergeEntry.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .queued: ("Queued", .neutral)
        case .testing: ("Testing", .running)
        case .merging: ("Merging", .running)
        case .merged: ("Merged", .success)
        case .rejected: ("Rejected", .error)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension Machine.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .online: ("Online", .success)
        case .offline: ("Offline", .error)
        case .draining: ("Draining", .warning)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension Account.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .active: ("Active", .success)
        case .cooling: ("Cooling down", .warning)
        case .disabled: ("Disabled", .neutral)
        case .invalid: ("Sign-in needed", .error)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension Job.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .queued: ("Queued", .neutral)
        case .leased, .running: ("Running", .running)
        case .passed: ("Passed", .success)
        case .failed: ("Failed", .error)
        case .cancelled: ("Cancelled", .neutral)
        case .error: ("Error", .error)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension Workflow.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .draft: ("Draft", .neutral)
        case .active: ("Active", .success)
        case .paused: ("Paused", .warning)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension Bottleneck.Severity {
    public var tone: StatusTone {
        switch self {
        case .critical: .error
        case .warning: .warning
        case .info, .unknown: .neutral
        }
    }

    public var title: String {
        switch self {
        case .critical: "Critical"
        case .warning: "Warning"
        case .info: "Note"
        case .unknown: "Note"
        }
    }
}

extension StatusLabel {
    public init(_ pair: (String, StatusTone)) { self.init(pair.0, tone: pair.1) }
}
