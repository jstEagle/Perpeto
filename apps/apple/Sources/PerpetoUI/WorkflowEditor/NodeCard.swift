import PerpetoKit
import SwiftUI

/// A node in the ruled drawing. White card, control border, 6 pt radius.
struct NodeCard: View {
    var node: GraphNode
    var mode: GraphMode
    var selected: Bool

    private var change: WorkflowDiff.Change? {
        if case .diff(let diff) = mode { return diff.nodes[node.id] }
        return nil
    }

    private var issues: [ValidationIssue] {
        if case .edit(let issues) = mode { return issues.filter { $0.nodeId == node.id } }
        return []
    }

    private var live: (NodeMetrics?, [Bottleneck], [WorkItem])? {
        if case .live(let overlay) = mode {
            return (overlay.metrics.node(node.id), overlay.metrics.bottlenecks(for: node.id), overlay.workItems.filter { $0.nodeId == node.id && $0.status != .done })
        }
        return nil
    }

    private var bottleneck: Bottleneck? { live?.1.max { $0.severity.rank < $1.severity.rank } }

    private var borderColor: Color {
        if let bottleneck { return bottleneck.severity.tone == .neutral ? PerpetoColor.controlBorder : bottleneck.severity.tone.color }
        switch change {
        case .added: return PerpetoColor.success
        case .changed: return PerpetoColor.warning
        case .removed: return PerpetoColor.error
        default: break
        }
        if issues.contains(where: { $0.severity == .error }) { return PerpetoColor.error }
        return PerpetoColor.controlBorder
    }

    private var borderWidth: CGFloat {
        (bottleneck != nil && bottleneck?.severity.tone != .neutral) || (change != nil && change != .unchanged) ? 2 : 1
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let live { liveBlock(metrics: live.0, items: live.2) }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, PerpetoSpacing.x(2.5))
        .padding(.top, PerpetoSpacing.x(2.5))
        .padding(.bottom, PerpetoSpacing.x(2))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous)
                .strokeBorder(borderColor, style: StrokeStyle(lineWidth: borderWidth, dash: change == .removed ? [4, 3] : [])))
        .overlay(alignment: .topTrailing) { gateLabels }
        .overlay(alignment: .topTrailing) {
            // Change kind sits on the top rule, like a label on a drawing.
            if let change, change != .unchanged {
                Tag(change.title, color: change.color).offset(x: -PerpetoSpacing.x(2), y: -10)
            }
        }
        .opacity(change == .removed ? 0.6 : (change == .unchanged ? 0.75 : 1))
        .selectionOutline(selected)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: PerpetoSpacing.x(1.5)) {
                Image(systemName: node.type.systemImage)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(PerpetoColor.muted)
                    .frame(width: 14)
                Text(node.label)
                    .font(.system(size: PerpetoType.text14, weight: .semibold))
                    .foregroundStyle(PerpetoColor.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if issues.contains(where: { $0.severity == .error }) {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(PerpetoColor.error).font(.system(size: 12))
                        .accessibilityLabel("Has validation errors")
                }
            }
            Text(meta)
                .font(PerpetoFont.caption)
                .foregroundStyle(PerpetoColor.muted)
                .lineLimit(1)
                .padding(.trailing, node.type.isGate ? 26 : 0)
            if let model = node.harness?.model {
                Text(model).font(PerpetoFont.mono()).foregroundStyle(PerpetoColor.muted).lineLimit(1)
                    .padding(.trailing, node.type.isGate ? 26 : 0)
            }
        }
    }

    @ViewBuilder
    private var gateLabels: some View {
        if node.type.isGate {
            ZStack(alignment: .topTrailing) {
                Text("pass").padding(.top, 30 - 8)
                Text("fail").padding(.top, 52 - 8)
            }
            .font(PerpetoFont.caption)
            .foregroundStyle(PerpetoColor.muted)
            .padding(.trailing, PerpetoSpacing.x(2))
            .allowsHitTesting(false)
        }
    }

    private var meta: String {
        let c = node.config
        switch node.type {
        case .input: return "From " + (c["source"]?.stringValue ?? "manual")
        case .planner: return [node.harness.map { Format.provider($0.provider) }, c["maxItems"]?.intValue.map { "up to \($0) items" }].compactMap { $0 }.joined(separator: " · ")
        case .agent, .review:
            return [node.harness.map { Format.provider($0.provider) }, "×\(node.concurrency ?? 1)"].compactMap { $0 }.joined(separator: " · ")
        case .ci: return Format.plural(c["steps"]?.arrayValue?.count ?? 0, "step") + ((c["requirements"]?["os"]?.stringValue).map { " · \($0)" } ?? "")
        case .mergeQueue: return [(c["strategy"]?.stringValue ?? "serial").capitalized, c["method"]?.stringValue].compactMap { $0 }.joined(separator: " · ")
        case .loop: return "Max \(c["maxIterations"]?.intValue ?? 0) · until \((c["until"]?.stringValue ?? "manual").replacingOccurrences(of: "-", with: " "))"
        case .human: return "Waits for a person"
        case .output: return "Finished work"
        case .unknown: return "Unrecognised type"
        }
    }

    @ViewBuilder
    private func liveBlock(metrics: NodeMetrics?, items: [WorkItem]) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            Rule().padding(.vertical, PerpetoSpacing.x(1))
            if let m = metrics, node.type != .input, node.type != .output {
                HStack {
                    stat(node.type.isAgentRole && m.concurrency != nil ? "\(m.active) of \(m.concurrency!) active" : "\(m.active) active")
                    Spacer(minLength: 2)
                    stat("\(m.queued) queued", emphasis: m.queued > 0)
                }
                HStack {
                    stat("Wait " + Format.duration(m.waitSec.avg))
                    Spacer(minLength: 2)
                    stat(Format.rate(m.throughputPerHour))
                }
                if let utilization = m.utilization {
                    Meter(utilization, tone: utilization >= 0.9 ? (bottleneck?.severity.tone ?? .warning) : .neutral)
                        .accessibilityLabel("Utilization")
                }
            } else if let m = metrics {
                stat(node.type == .output ? "\(m.done) finished" : "\(m.done) items in")
            } else {
                stat("No measurements")
            }
            markers(items)
            if let bottleneck {
                HStack(spacing: PerpetoSpacing.x(1)) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10))
                    Text(bottleneck.reason.title).font(PerpetoFont.captionMedium).lineLimit(1)
                }
                .foregroundStyle(bottleneck.severity.tone == .neutral ? PerpetoColor.muted : bottleneck.severity.tone.color)
            }
        }
    }

    private func stat(_ text: String, emphasis: Bool = false) -> some View {
        Text(text)
            .font(PerpetoFont.caption.monospacedDigit())
            .foregroundStyle(emphasis ? PerpetoColor.ink : PerpetoColor.muted)
            .lineLimit(1)
    }

    /// Work items currently at this node: filled for active, outlined for queued.
    private func markers(_ items: [WorkItem]) -> some View {
        let shown = items.prefix(12)
        return HStack(spacing: 3) {
            ForEach(Array(shown)) { item in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(item.status == .active ? PerpetoColor.ink : (item.status == .failed ? PerpetoColor.error : PerpetoColor.surface))
                    .overlay(RoundedRectangle(cornerRadius: 1.5).strokeBorder(item.status == .failed ? PerpetoColor.error : PerpetoColor.ink, lineWidth: 1))
                    .frame(width: 7, height: 7)
                    .help(item.title)
            }
            if items.count > shown.count {
                Text("+\(items.count - shown.count)").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
        }
        .frame(height: 10)
        .accessibilityLabel("\(items.count) work items here")
    }
}

extension WorkflowDiff.Change {
    var title: String {
        switch self {
        case .added: "Added"
        case .removed: "Removed"
        case .changed: "Changed"
        case .unchanged: "Unchanged"
        }
    }

    var color: Color {
        switch self {
        case .added: PerpetoColor.success
        case .removed: PerpetoColor.error
        case .changed: PerpetoColor.warning
        case .unchanged: PerpetoColor.muted
        }
    }
}
