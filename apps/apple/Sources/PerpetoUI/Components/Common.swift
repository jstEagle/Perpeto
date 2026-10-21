import PerpetoKit
import SwiftUI

/// One labelled figure in a ruled strip.
public struct Figure: View {
    var label: String
    var value: String
    var detail: String?
    var tone: StatusTone?

    public init(_ label: String, value: String, detail: String? = nil, tone: StatusTone? = nil) {
        self.label = label
        self.value = value
        self.detail = detail
        self.tone = tone
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            Text(label).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            Text(value)
                .font(PerpetoFont.figure())
                .foregroundStyle(tone.map(\.color) ?? PerpetoColor.ink)
                .contentTransition(.numericText())
            if let detail {
                Text(detail).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Figures separated by vertical rules inside one panel, with stable columns.
public struct FigureStrip: View {
    var figures: [Figure]
    public init(_ figures: [Figure]) { self.figures = figures }

    public var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(figures.enumerated()), id: \.offset) { index, figure in
                if index > 0 { Rule(vertical: true).padding(.horizontal, PerpetoSpacing.x(4)) }
                figure
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .panel(padding: PerpetoSpacing.x(4))
    }
}

/// Empty state with one useful next action.
public struct EmptyState<Action: View>: View {
    var title: String
    var message: String
    var action: Action

    public init(_ title: String, message: String, @ViewBuilder action: () -> Action = { EmptyView() }) {
        self.title = title
        self.message = message
        self.action = action()
    }

    public var body: some View {
        VStack(spacing: PerpetoSpacing.x(3)) {
            SpindleShape().fill(PerpetoColor.border).frame(width: 40, height: 40)
            Text(title).font(PerpetoFont.title()).foregroundStyle(PerpetoColor.ink)
            Text(message).font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).multilineTextAlignment(.center).frame(maxWidth: 420)
            action
        }
        .padding(PerpetoSpacing.x(10))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The Spindle "Flywheel" loader from brand/motion: continuous rotation,
/// 2.4 s per turn. Shows the complete static mark under reduced motion.
public struct SpindleLoader: View {
    var size: CGFloat
    var color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(size: CGFloat = 20, color: Color = PerpetoColor.accent) {
        self.size = size
        self.color = color
    }

    public var body: some View {
        if reduceMotion {
            SpindleShape().fill(color).frame(width: size, height: size)
        } else {
            TimelineView(.animation) { context in
                let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.4) / 2.4
                SpindleShape().fill(color).frame(width: size, height: size).rotationEffect(.degrees(t * 360))
            }
        }
    }
}

/// Monospace identifier text.
public struct Mono: View {
    var text: String
    var color: Color
    public init(_ text: String, color: Color = PerpetoColor.muted) {
        self.text = text
        self.color = color
    }
    public var body: some View {
        Text(text).font(PerpetoFont.mono()).foregroundStyle(color).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
    }
}

/// Thin horizontal meter for utilization and capacity.
public struct Meter: View {
    var fraction: Double
    var tone: StatusTone

    public init(_ fraction: Double, tone: StatusTone = .neutral) {
        self.fraction = fraction
        self.tone = tone
    }

    public var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2).fill(PerpetoColor.border.opacity(0.6))
                RoundedRectangle(cornerRadius: 2)
                    .fill(tone == .neutral ? PerpetoColor.ink : tone.color)
                    .frame(width: proxy.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: 4)
        .accessibilityValue(Format.percent(fraction))
    }
}

/// Error banner naming the affected operation and the recovery path.
public struct ErrorBanner: View {
    var message: String
    var dismiss: () -> Void

    public init(_ message: String, dismiss: @escaping () -> Void) {
        self.message = message
        self.dismiss = dismiss
    }

    public var body: some View {
        HStack(spacing: PerpetoSpacing.x(2)) {
            Image(systemName: "exclamationmark.triangle").foregroundStyle(PerpetoColor.error)
            Text(message).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink)
            Spacer()
            Button("Dismiss", action: dismiss).buttonStyle(.perpetoGhost)
        }
        .padding(.horizontal, PerpetoSpacing.x(3))
        .padding(.vertical, PerpetoSpacing.x(2))
        .background(PerpetoColor.surface)
        .overlay(alignment: .leading) { Rectangle().fill(PerpetoColor.error).frame(width: 3) }
        .overlay(alignment: .bottom) { Rule() }
    }
}
