import PerpetoKit
import SwiftUI

/// A metric: the value in 32 semibold tabular figures, the label beneath in
/// 13 muted. Units sit after the value in 16 medium muted ("6.4 h").
public struct Figure: View {
    var label: String
    var value: String
    var unit: String?
    var detail: String?
    var size: CGFloat

    public init(_ label: String, value: String, unit: String? = nil, detail: String? = nil, size: CGFloat = PerpetoType.text32, tone: StatusTone? = nil) {
        self.label = label
        self.value = value
        self.unit = unit
        self.detail = detail
        self.size = size
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(value)
                    .font(PerpetoFont.figure(size))
                    .tracking(PerpetoType.tracking(forHeading: size))
                    .foregroundStyle(PerpetoColor.ink)
                    .contentTransition(.numericText())
                if let unit {
                    Text(unit).font(PerpetoType.text(PerpetoType.text16, weight: .medium)).foregroundStyle(PerpetoColor.muted)
                }
            }
            Text(label).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(2)
            if let detail {
                Text(detail).font(PerpetoFont.small).foregroundStyle(PerpetoColor.muted).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// Splits "6.4 h" into value and unit.
    public static func duration(_ label: String, seconds: Double?) -> Figure {
        let text = Format.duration(seconds)
        let parts = text.split(separator: " ", maxSplits: 1).map(String.init)
        return Figure(label, value: parts.first ?? text, unit: parts.count > 1 ? parts[1] : nil)
    }
}

/// Up to three metrics side by side, no rules. Pairs on narrow screens.
public struct FigureStrip: View {
    var figures: [Figure]
    public init(_ figures: [Figure]) { self.figures = figures }

    @Environment(\.compactLayout) private var compact

    public var body: some View {
        if compact && figures.count > 3 {
            LazyVGrid(columns: [GridItem(.flexible(), alignment: .topLeading), GridItem(.flexible(), alignment: .topLeading)], alignment: .leading, spacing: PerpetoSpacing.x(5)) {
                ForEach(Array(figures.enumerated()), id: \.offset) { _, figure in figure }
            }
        } else {
            HStack(alignment: .top, spacing: PerpetoSpacing.x(compact ? 4 : 8)) {
                ForEach(Array(figures.enumerated()), id: \.offset) { _, figure in figure }
            }
        }
    }
}

/// Rows separated by hairlines, none above the first or below the last.
public struct RowList<Item: Identifiable, Row: View>: View {
    var items: [Item]
    var row: (Item) -> Row

    public init(_ items: [Item], @ViewBuilder row: @escaping (Item) -> Row) {
        self.items = items
        self.row = row
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { Rule() }
                row(item).padding(.vertical, PerpetoSpacing.x(4))
            }
        }
    }
}

/// A title and a meta line, for list rows.
public struct RowText: View {
    var title: String
    var meta: String?
    var monoTitle: Bool

    public init(_ title: String, meta: String? = nil, mono: Bool = false) {
        self.title = title
        self.meta = meta
        self.monoTitle = mono
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(monoTitle ? PerpetoFont.mono(PerpetoType.text14) : PerpetoFont.bodyMedium)
                .foregroundStyle(PerpetoColor.ink)
                .lineLimit(2)
            if let meta, !meta.isEmpty {
                Text(meta).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(2)
            }
        }
    }
}

/// A rounded tile behind a row or node icon.
public struct IconTile: View {
    var systemImage: String
    var size: CGFloat
    public init(_ systemImage: String, size: CGFloat = PerpetoIcon.tile) {
        self.systemImage = systemImage
        self.size = size
    }
    public var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: size * 0.42, weight: .regular))
            .foregroundStyle(PerpetoColor.inkSoft)
            .frame(width: size, height: size)
            .background(PerpetoColor.surfaceSubtle, in: RoundedRectangle(cornerRadius: size >= PerpetoIcon.tile ? PerpetoRadius.control : PerpetoRadius.small, style: .continuous))
    }
}

/// Empty state: a tile, a 20 pt title, one sentence and one large primary.
public struct EmptyState<Action: View>: View {
    var title: String
    var message: String
    var systemImage: String
    var action: Action

    public init(_ title: String, message: String, systemImage: String = "tray", @ViewBuilder action: () -> Action = { EmptyView() }) {
        self.title = title
        self.message = message
        self.systemImage = systemImage
        self.action = action()
    }

    public var body: some View {
        VStack(spacing: PerpetoSpacing.x(3)) {
            IconTile(systemImage, size: 48)
            Text(title).font(PerpetoFont.title(PerpetoType.text20)).foregroundStyle(PerpetoColor.ink).padding(.top, PerpetoSpacing.x(2))
            Text(message).font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).multilineTextAlignment(.center).frame(maxWidth: 420)
            action.controlSize(.large).padding(.top, PerpetoSpacing.x(3))
        }
        .padding(PerpetoSpacing.x(12))
        .frame(maxWidth: .infinity)
    }
}

/// The Spindle "Flywheel" loader from brand/motion: continuous rotation,
/// 2.4 s per turn. The only page-level loader. Static under reduced motion.
public struct SpindleLoader: View {
    var size: CGFloat
    var color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(size: CGFloat = 20, color: Color = PerpetoColor.ink) {
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

/// Monospace identifier text: run IDs, repositories, branches, machines.
public struct Mono: View {
    var text: String
    var color: Color
    var size: CGFloat
    public init(_ text: String, color: Color = PerpetoColor.muted, size: CGFloat = PerpetoType.text13) {
        self.text = text
        self.color = color
        self.size = size
    }
    public var body: some View {
        Text(text).font(PerpetoFont.mono(size)).foregroundStyle(color).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
    }
}

/// A 4 pt pill meter: quiet track, ink fill.
public struct Meter: View {
    var fraction: Double

    public init(_ fraction: Double, tone: StatusTone = .neutral) {
        self.fraction = fraction
    }

    public var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(PerpetoColor.chartQuiet)
                Capsule().fill(PerpetoColor.ink)
                    .frame(width: proxy.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: 4)
        .accessibilityValue(Format.percent(fraction))
    }
}

/// An error naming the affected operation and the recovery path.
public struct ErrorBanner: View {
    var message: String
    var dismiss: () -> Void

    public init(_ message: String, dismiss: @escaping () -> Void) {
        self.message = message
        self.dismiss = dismiss
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(3)) {
            StatusIcon(.error)
            Text(message).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: PerpetoSpacing.x(2))
            Button("Dismiss", action: dismiss).buttonStyle(.perpetoGhost).controlSize(.small)
        }
        .padding(.horizontal, PerpetoSpacing.x(5))
        .padding(.vertical, PerpetoSpacing.x(3))
        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.node, style: .continuous))
        .perpetoElevation(.raised, cornerRadius: PerpetoRadius.node)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }
}

/// Bars for a single series: grey bars with pill tops, the current period in
/// ink, empty periods as short stubs, labels only at the ends.
public struct TrendBars: View {
    var values: [Double]
    var start: String
    var end: String

    public init(_ values: [Double], start: String, end: String = "Now") {
        self.values = values
        self.start = start
        self.end = end
    }

    public var body: some View {
        VStack(spacing: PerpetoSpacing.x(2)) {
            GeometryReader { proxy in
                let maxValue = max(values.max() ?? 1, 1)
                let gap: CGFloat = values.count > 14 ? 3 : 4
                let width = max(2, (proxy.size.width - gap * CGFloat(max(values.count - 1, 0))) / CGFloat(max(values.count, 1)))
                HStack(alignment: .bottom, spacing: gap) {
                    ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                        let last = index == values.count - 1
                        if value <= 0 {
                            Capsule().fill(PerpetoColor.chartQuiet).frame(width: width, height: 2)
                        } else {
                            UnevenRoundedRectangle(topLeadingRadius: width / 2, topTrailingRadius: width / 2, style: .continuous)
                                .fill(last ? PerpetoColor.chartStrong : PerpetoColor.chart)
                                .frame(width: width, height: max(4, proxy.size.height * value / maxValue))
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
            Rule()
            HStack {
                Text(start)
                Spacer()
                Text(end)
            }
            .font(PerpetoFont.small)
            .foregroundStyle(PerpetoColor.muted)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Int(values.reduce(0, +))) items over \(values.count) periods")
    }
}
