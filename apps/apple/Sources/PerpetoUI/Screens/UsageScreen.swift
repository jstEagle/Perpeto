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

    /// Series are told apart by grey value, never by hue.
    var color: Color {
        switch self {
        case .input: PerpetoColor.ink
        case .output: PerpetoColor.grey500
        case .cacheWrite: PerpetoColor.grey300
        case .cacheRead: PerpetoColor.grey100
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
                AxisValueLabel {
                    if let v = value.as(Double.self) { Text(Format.compact(v)).font(PerpetoFont.small).foregroundStyle(PerpetoColor.muted) }
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

/// Shares with explicit numbers and a quiet meter.
struct BreakdownPanel: View {
    var title: String
    var groups: [UsageGroup]
    var name: (String) -> String

    var body: some View {
        let total = max(groups.reduce(0) { $0 + $1.totalTokens }, 1)
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle(title)
            if groups.isEmpty {
                Text("No usage recorded.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(3))
            }
            RowList(groups.sorted { $0.totalTokens > $1.totalTokens }) { group in
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                    HStack {
                        Text(name(group.key)).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                        Spacer()
                        Text(Format.tokens(group.totalTokens)).font(PerpetoFont.bodyMedium.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                        Text(Format.percent(Double(group.totalTokens) / Double(total)))
                            .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                            .frame(width: 40, alignment: .trailing)
                    }
                    Meter(Double(group.totalTokens) / Double(total))
                }
            }
        }
        .card()
    }
}

struct UsageScreen: View {
    var store: FactoryStore
    @Environment(\.compactLayout) private var compact
    @State private var more = false

    var body: some View {
        let usage = store.factory.usage
        let totals = UsageGroup(
            key: "total",
            inputTokens: usage.byDay.reduce(0) { $0 + $1.inputTokens },
            outputTokens: usage.byDay.reduce(0) { $0 + $1.outputTokens },
            cacheReadTokens: usage.byDay.reduce(0) { $0 + $1.cacheReadTokens },
            cacheWriteTokens: usage.byDay.reduce(0) { $0 + $1.cacheWriteTokens })
        let cost = usage.byDay.compactMap(\.costUsd).reduce(0, +)
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Usage", subtitle: "Tokens reported by harnesses across every project and machine, over \(Format.plural(usage.byDay.count, "day")).")
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) {
                    FigureStrip([
                        Figure("Tokens today", value: Format.tokens(usage.today)),
                        Figure("Tokens in \(Format.plural(usage.byDay.count, "day"))", value: Format.tokens(totals.totalTokens)),
                        Figure("Reported cost", value: cost > 0 ? String(format: "$%.0f", cost) : "None"),
                    ])
                    Disclosure("More metrics", isExpanded: $more) {
                        FigureStrip([
                            Figure("Input", value: Format.tokens(totals.inputTokens), size: PerpetoType.text20),
                            Figure("Output", value: Format.tokens(totals.outputTokens), size: PerpetoType.text20),
                            Figure("Served from cache", value: Format.percent(Double(totals.cacheReadTokens) / Double(max(totals.totalTokens, 1))), size: PerpetoType.text20),
                        ])
                    }
                }
                .card()
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
                    SectionTitle("Tokens per day")
                    HStack(spacing: PerpetoSpacing.x(4)) {
                        ForEach(TokenKind.allCases) { kind in
                            HStack(spacing: PerpetoSpacing.x(1.5)) {
                                RoundedRectangle(cornerRadius: 2).fill(kind.color).frame(width: 10, height: 10)
                                Text(kind.rawValue)
                            }
                        }
                    }
                    .font(PerpetoFont.small).foregroundStyle(PerpetoColor.muted)
                    TokenDayChart(groups: usage.byDay, compact: true)
                        .frame(height: 220)
                }
                .card()
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: PerpetoGap.cards, alignment: .top), count: compact ? 1 : 2),
                          alignment: .leading, spacing: PerpetoGap.cards) {
                    BreakdownPanel(title: "By role", groups: usage.byRole, name: roleName)
                    BreakdownPanel(title: "By model", groups: usage.byModel, name: Format.model)
                    BreakdownPanel(title: "By provider", groups: usage.byProvider, name: Format.provider)
                    BreakdownPanel(title: "By machine", groups: usage.byMachine, name: { id in store.machine(id)?.name ?? id })
                }
                projectList
            }
            .screenPadding()
        }
    }

    /// Role ids read as their step names where a workflow defines them.
    private func roleName(_ role: String) -> String {
        if role == "unknown" { return "Not recorded" }
        for project in store.factory.projects {
            for workflow in store.state(project.id).workflows {
                if let node = workflow.graph.nodes.first(where: { ($0.config["role"]?.stringValue ?? $0.id) == role }) { return node.label }
            }
        }
        return role.prefix(1).uppercased() + role.dropFirst()
    }

    private var projectList: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle("By project")
            RowList(store.factory.projects) { project in
                let state = store.state(project.id)
                HStack {
                    RowText(project.name, meta: Format.plural(state.activeAgents, "agent") + " working")
                    Spacer()
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(Format.tokens(state.usage.today) + " today").font(PerpetoFont.bodyMedium.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                        Text(Format.tokens(state.usage.total) + " in total").font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                    }
                }
            }
        }
        .card()
    }
}
