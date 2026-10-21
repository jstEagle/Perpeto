import Charts
import PerpetoKit
import SwiftUI

/// Token types and their colors, used by every usage chart.
enum TokenKind: String, CaseIterable, Identifiable {
    case input = "Input"
    case output = "Output"
    case cacheWrite = "Cache write"
    case cacheRead = "Cache read"

    var id: String { rawValue }

    var color: Color {
        switch self {
        case .input: PerpetoColor.ink
        case .output: PerpetoColor.accent
        case .cacheWrite: PerpetoColor.controlBorder
        case .cacheRead: PerpetoColor.border
        }
    }

    func value(_ group: UsageGroup) -> Int {
        switch self {
        case .input: group.inputTokens
        case .output: group.outputTokens
        case .cacheWrite: group.cacheWriteTokens
        case .cacheRead: group.cacheReadTokens
        }
    }
}

/// Stacked daily token usage by type.
struct TokenDayChart: View {
    var groups: [UsageGroup]
    var compact = false

    var body: some View {
        Chart {
            ForEach(groups) { group in
                ForEach(TokenKind.allCases) { kind in
                    BarMark(
                        x: .value("Day", HubCoding.parseDate(group.key + "T00:00:00Z") ?? Date(), unit: .day),
                        y: .value("Tokens", kind.value(group)))
                        .foregroundStyle(by: .value("Type", kind.rawValue))
                }
            }
        }
        .chartForegroundStyleScale(domain: TokenKind.allCases.map(\.rawValue), range: TokenKind.allCases.map(\.color))
        // Always at least two weeks wide, so a new hub's first day is one bar, not the whole chart.
        .chartXScale(domain: dayDomain)
        .chartLegend(compact ? .hidden : .visible)
        .chartLegend(position: .top, alignment: .leading)
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: compact ? 3 : 5)) { value in
                AxisGridLine().foregroundStyle(PerpetoColor.border)
                AxisValueLabel {
                    if let v = value.as(Double.self) { Text(Format.compact(v)).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted) }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: compact ? 4 : 2)) { _ in
                AxisValueLabel(format: .dateTime.month(.abbreviated).day()).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
        }
        .accessibilityLabel("Tokens per day by type")
    }

    private var dayDomain: ClosedRange<Date> {
        let days = groups.compactMap { HubCoding.parseDate($0.key + "T00:00:00Z") }
        let last = (days.max() ?? Date()).addingTimeInterval(86400)
        let first = min(days.min() ?? last, last.addingTimeInterval(-14 * 86400))
        return first...last
    }
}

/// Horizontal share bars with explicit numbers.
struct BreakdownPanel: View {
    var title: String
    var groups: [UsageGroup]
    var name: (String) -> String

    var body: some View {
        let total = max(groups.reduce(0) { $0 + $1.totalTokens }, 1)
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            SectionTitle(title)
            if groups.isEmpty {
                Text("No usage recorded.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
            }
            ForEach(groups.sorted { $0.totalTokens > $1.totalTokens }) { group in
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                    HStack {
                        Text(name(group.key)).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                        Spacer()
                        Text(Format.tokens(group.totalTokens)).font(PerpetoFont.bodyMedium.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                        Text(Format.percent(Double(group.totalTokens) / Double(total)))
                            .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                            .frame(width: 36, alignment: .trailing)
                    }
                    GeometryReader { proxy in
                        HStack(spacing: 0) {
                            ForEach(TokenKind.allCases) { kind in
                                Rectangle().fill(kind.color)
                                    .frame(width: proxy.size.width * CGFloat(kind.value(group)) / CGFloat(total))
                            }
                        }
                    }
                    .frame(height: 6)
                    .clipShape(RoundedRectangle(cornerRadius: 2))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .panel()
    }
}

struct UsageScreen: View {
    var store: FactoryStore
    @Environment(\.compactLayout) private var compact

    var body: some View {
        let usage = store.factory.usage
        let totals = UsageGroup(
            key: "all",
            inputTokens: usage.byDay.reduce(0) { $0 + $1.inputTokens },
            outputTokens: usage.byDay.reduce(0) { $0 + $1.outputTokens },
            cacheReadTokens: usage.byDay.reduce(0) { $0 + $1.cacheReadTokens },
            cacheWriteTokens: usage.byDay.reduce(0) { $0 + $1.cacheWriteTokens })
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) {
                ScreenHeader("Usage", subtitle: "Tokens reported by harnesses across every project and machine, over \(Format.plural(usage.byDay.count, "day")).")
                FigureStrip([
                    Figure("Total", value: Format.tokens(totals.totalTokens), detail: Format.plural(usage.byDay.count, "day")),
                    Figure("Today", value: Format.tokens(usage.today), detail: "UTC day"),
                    Figure("Input", value: Format.tokens(totals.inputTokens)),
                    Figure("Output", value: Format.tokens(totals.outputTokens)),
                    Figure("Cache reads", value: Format.percent(Double(totals.cacheReadTokens) / Double(max(totals.totalTokens, 1))), detail: "of all tokens"),
                ])
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                    SectionTitle("Tokens per day")
                    TokenDayChart(groups: usage.byDay)
                        .frame(height: 260)
                }
                .panel()
                let breakdowns = Group {
                    BreakdownPanel(title: "By provider", groups: usage.byProvider, name: Format.provider)
                    BreakdownPanel(title: "By model", groups: usage.byModel, name: { $0 })
                    BreakdownPanel(title: "By machine", groups: usage.byMachine, name: { id in store.machine(id)?.name ?? id })
                }
                if compact {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) { breakdowns }
                } else {
                    HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) { breakdowns }
                }
                projectTable
            }
            .screenPadding()
            .frame(maxWidth: 1240, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var projectTable: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionTitle("By project").padding(.bottom, PerpetoSpacing.x(3))
            HStack {
                Text("Project").frame(maxWidth: .infinity, alignment: .leading)
                Text(compact ? "Agents" : "Agents working").frame(width: compact ? 56 : 120, alignment: .trailing)
                Text("Today").frame(width: compact ? 64 : 100, alignment: .trailing)
                Text("Total").frame(width: compact ? 64 : 100, alignment: .trailing)
            }
            .font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
            .padding(.bottom, PerpetoSpacing.x(2))
            Rule()
            ForEach(store.factory.projects) { project in
                let state = store.state(project.id)
                HStack {
                    Text(project.name).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink).frame(maxWidth: .infinity, alignment: .leading)
                    Text("\(state.activeAgents)").frame(width: compact ? 56 : 120, alignment: .trailing)
                    Text(Format.tokens(state.usage.today)).frame(width: compact ? 64 : 100, alignment: .trailing)
                    Text(Format.tokens(state.usage.total)).frame(width: compact ? 64 : 100, alignment: .trailing)
                }
                .font(PerpetoFont.body.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                .padding(.vertical, PerpetoSpacing.x(2.5))
                Rule()
            }
        }
        .panel()
    }
}
