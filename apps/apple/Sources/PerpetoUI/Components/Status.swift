import PerpetoKit
import SwiftUI

/// Status is told by icon, word and weight. Orange appears only as the live
/// dot; red only for failure. Everything else is ink and greys.
public enum StatusTone: Sendable, Hashable {
    /// Work is happening now: the orange live dot, ink medium.
    case running
    /// A person should look (saturated, attention): filled ink circle, medium.
    case warning
    /// A person must decide: filled ink triangle, medium.
    case approval
    /// Waiting on another item: outline circle with a bar.
    case blocked
    /// Accepted, not started, idle or not reached: faint outline circle.
    case neutral
    /// Stopped by a person.
    case paused, stopped
    /// Healthy and available, such as an online machine.
    case ok
    /// Only when named checks passed, or the work is done.
    case success
    /// Failed: outline cross in red. Name the operation and the recovery.
    case error
    /// Turned away without being a failure of the system, such as a rejected PR.
    case dismissed

    var symbol: String? {
        switch self {
        case .running: nil
        case .warning: "exclamationmark.circle.fill"
        case .approval: "exclamationmark.triangle.fill"
        case .blocked: "minus.circle"
        case .neutral: "circle"
        case .paused: "pause.circle"
        case .stopped: "stop.circle"
        case .ok: "circle.fill"
        case .success: "checkmark.circle"
        case .error, .dismissed: "xmark.circle"
        }
    }

    var iconColor: Color {
        switch self {
        case .running: PerpetoColor.accent
        case .warning, .approval: PerpetoColor.ink
        case .blocked, .success: PerpetoColor.inkSoft
        case .neutral, .paused, .stopped, .dismissed: PerpetoColor.faint
        case .ok: PerpetoColor.faint
        case .error: PerpetoColor.error
        }
    }

    var textColor: Color {
        switch self {
        case .running, .warning, .approval: PerpetoColor.ink
        case .blocked, .success, .ok: PerpetoColor.inkSoft
        case .neutral, .paused, .stopped, .dismissed: PerpetoColor.muted
        case .error: PerpetoColor.error
        }
    }

    /// Things that need a person, or are failing, read in medium weight.
    var weight: Font.Weight {
        switch self {
        case .running, .warning, .approval, .error: .medium
        default: .regular
        }
    }

    /// Kept for meters and borders that follow a status.
    public var color: Color { iconColor }
}

/// The live dot: 8 pt signal orange with a soft halo. Static, never pulsing.
public struct LiveDot: View {
    var size: CGFloat
    public init(size: CGFloat = PerpetoIndicator.dot) { self.size = size }
    public var body: some View {
        Circle().fill(PerpetoColor.accent)
            .frame(width: size, height: size)
            .padding(PerpetoIndicator.halo / 2)
            .background(Circle().fill(PerpetoColor.accentWash))
            .accessibilityLabel("Live")
    }
}

/// The status icon alone, at 16 pt.
public struct StatusIcon: View {
    var tone: StatusTone
    var size: CGFloat
    public init(_ tone: StatusTone, size: CGFloat = PerpetoIcon.small) {
        self.tone = tone
        self.size = size
    }
    public var body: some View {
        if let symbol = tone.symbol {
            Image(systemName: symbol)
                .font(.system(size: tone == .ok ? size * 0.5 : size * 0.85, weight: .regular))
                .foregroundStyle(tone.iconColor)
                .frame(width: size, height: size)
        } else {
            LiveDot().frame(width: size, height: size)
        }
    }
}

/// Inline status: a 16 pt icon, 8 pt gap and a 13 pt word.
public struct StatusLabel: View {
    var text: String
    var tone: StatusTone

    public init(_ text: String, tone: StatusTone) {
        self.text = text
        self.tone = tone
    }

    public var body: some View {
        HStack(spacing: PerpetoSpacing.x(2)) {
            StatusIcon(tone)
            Text(text)
                .font(PerpetoType.text(PerpetoType.text13, weight: tone.weight))
                .foregroundStyle(tone.textColor)
                .lineLimit(1)
        }
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

/// Header form: a 28 pt white pill with card elevation.
public struct StatusChip: View {
    var text: String
    var tone: StatusTone
    public init(_ text: String, tone: StatusTone) {
        self.text = text
        self.tone = tone
    }
    public var body: some View {
        StatusLabel(text, tone: tone)
            .padding(.horizontal, PerpetoSpacing.x(3))
            .frame(height: 28)
            .background(Capsule(style: .continuous).fill(PerpetoColor.surface))
            .pillElevation(.card, height: 28)
    }
}

/// Quiet chip for versions, counts and change kinds: subtle fill, no shadow.
public struct Tag: View {
    var text: String
    var systemImage: String?

    public init(_ text: String, color: Color = PerpetoColor.muted, systemImage: String? = nil) {
        self.text = text
        self.systemImage = systemImage
    }

    public var body: some View {
        HStack(spacing: PerpetoSpacing.x(1)) {
            if let systemImage { Image(systemName: systemImage).font(.system(size: 10, weight: .medium)) }
            Text(text).font(PerpetoFont.small).lineLimit(1)
        }
        .foregroundStyle(PerpetoColor.inkSoft)
        .padding(.horizontal, PerpetoSpacing.x(2.5))
        .frame(height: 22)
        .background(Capsule(style: .continuous).fill(PerpetoColor.surfaceSubtle))
        .fixedSize()
    }
}

// MARK: Status mapping

extension Run.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .running: ("Running", .running)
        case .paused: ("Paused", .paused)
        case .stopped: ("Stopped", .stopped)
        case .completed: ("Completed", .success)
        case .failed: ("Failed", .error)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension WorkItem {
    /// A blocked item with a decisionId is waiting for a person.
    public var statusLabel: (String, StatusTone) {
        if status == .blocked, decisionId != nil { return ("Approval needed", .approval) }
        return status.label
    }
}

extension WorkItem.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .queued: ("Queued", .neutral)
        case .active: ("Active", .running)
        case .blocked: ("Blocked", .blocked)
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
        case .leased: ("Starting", .running)
        case .running: ("Running", .running)
        case .succeeded: ("Succeeded", .success)
        case .failed: ("Failed", .error)
        case .cancelled: ("Cancelled", .stopped)
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
        case .online: ("Online", .ok)
        case .offline: ("Offline", .stopped)
        case .draining: ("Draining", .paused)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension Account.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .active: ("Ready", .ok)
        case .cooling: ("Cooling down", .paused)
        case .disabled: ("Disabled", .stopped)
        case .invalid: ("Sign-in needed", .approval)
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
        case .cancelled: ("Cancelled", .stopped)
        case .error: ("Error", .error)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension Workflow.Status {
    public var label: (String, StatusTone) {
        switch self {
        case .draft: ("Draft", .neutral)
        case .active: ("Active", .ok)
        case .paused: ("Paused", .paused)
        case .unknown: ("Unknown", .neutral)
        }
    }
}

extension Bottleneck.Severity {
    public var tone: StatusTone {
        switch self {
        case .critical, .warning: .warning
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

extension StatusChip {
    public init(_ pair: (String, StatusTone)) { self.init(pair.0, tone: pair.1) }
}
