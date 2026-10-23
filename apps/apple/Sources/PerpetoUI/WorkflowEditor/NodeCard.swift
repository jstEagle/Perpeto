import PerpetoKit
import SwiftUI

/// A step on the map: a white card with 16 pt corners and soft elevation.
/// An icon tile, the name and one line of meta; on the live map a stat line
/// and a meter at the bottom, and the live dot while the step has work.
/// The card itself is never tinted: attention reads from the stat line.
struct NodeCard: View {
    var node: GraphNode
    var mode: GraphMode
    var selected: Bool
    var lifted = false
    /// Name and stat line only, for fitting a whole run on screen.
    var compact = false
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var change: WorkflowDiff.Change? {
        if case .diff(let diff) = mode { return diff.nodes[node.id] }
        return nil
    }

    private var issues: [ValidationIssue] {
        if case .edit(let issues) = mode { return issues.filter { $0.nodeId == node.id } }
        return []
    }

    private var live: (metrics: NodeMetrics?, bottlenecks: [Bottleneck], items: [WorkItem])? {
        if case .live(let overlay) = mode {
            return (overlay.metrics.node(node.id), overlay.metrics.bottlenecks(for: node.id), overlay.workItems.filter { $0.nodeId == node.id && $0.status != .done })
        }
        return nil
    }

    private var bottleneck: Bottleneck? { live?.bottlenecks.filter { $0.severity != .info }.max { $0.severity.rank < $1.severity.rank } }
    private var isLiveNow: Bool { (live?.metrics?.active ?? 0) > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Spacer(minLength: 0)
            if let live { stats(live.metrics) }
            if let error = issues.first(where: { $0.severity == .error }) {
                StatusLabel(issues.count > 1 ? Format.plural(issues.count, "problem") : "Needs a fix", tone: .error)
                    .help(error.message)
            }
        }
        .padding(PerpetoSpacing.x(compact ? 3 : 4))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.node, style: .continuous))
        .overlay {
            if change == .removed {
                RoundedRectangle(cornerRadius: PerpetoRadius.node, style: .continuous)
                    .strokeBorder(PerpetoColor.faint, style: StrokeStyle(lineWidth: PerpetoStroke.edge, dash: [3, 4]))
            }
        }
        .perpetoElevation(lifted ? .overlay : (selected || hovering ? .raised : .card), cornerRadius: PerpetoRadius.node)
        .selectionOutline(selected)
        .overlay(alignment: .topTrailing) {
            if isLiveNow {
                LiveDot(size: PerpetoIndicator.dot).padding(PerpetoSpacing.x(compact ? 3 : 4) - PerpetoIndicator.halo / 2)
            } else if let change, change != .unchanged {
                Tag(change.title).offset(y: -11).padding(.trailing, PerpetoSpacing.x(4))
            }
        }
        .opacity(change == .removed ? 0.6 : 1)
        .offset(y: lifted ? -2 : 0)
        .onHover { hovering = $0 }
        .animation(PerpetoMotion.standard(reduceMotion: reduceMotion), value: hovering)
        .animation(PerpetoMotion.easeOut(reduceMotion: reduceMotion), value: selected)
    }

    private var header: some View {
        HStack(alignment: compact ? .center : .top, spacing: PerpetoSpacing.x(compact ? 2 : 3)) {
            IconTile(node.type.systemImage, size: compact ? 24 : 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(node.label)
                    .font(compact ? PerpetoFont.captionMedium : PerpetoFont.bodyMedium)
                    .foregroundStyle(PerpetoColor.ink)
                    .lineLimit(1)
                if !compact {
                    Text(meta)
                        .font(PerpetoFont.small)
                        .foregroundStyle(PerpetoColor.muted)
                        .lineLimit(1)
                }
            }
            .padding(.trailing, isLiveNow ? PerpetoSpacing.x(3) : 0)
        }
    }

    /// One stat line in 13 tabular figures and a 4 pt meter.
    @ViewBuilder
    private func stats(_ m: NodeMetrics?) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            HStack(alignment: .firstTextBaseline) {
                if let bottleneck {
                    StatusLabel(bottleneck.reason.title, tone: .warning)
                } else if node.type == .input {
                    stat("\(m?.done ?? 0) received", strong: true)
                } else if node.type == .output {
                    stat("\(m?.done ?? 0) finished", strong: true)
                } else if let m, m.active == 0, m.queued == 0 {
                    StatusLabel("Idle", tone: .neutral)
                } else if let m {
                    stat(m.concurrency.map { "\(m.active) of \($0) active" } ?? "\(m.active) active", strong: true)
                } else {
                    stat("No measurements", strong: false)
                }
                Spacer(minLength: PerpetoSpacing.x(1))
                if let m, node.type != .input, node.type != .output {
                    stat("\(m.queued) queued", strong: false)
                }
            }
            if node.type != .input && node.type != .output {
                Meter(m?.utilization ?? 0)
            }
        }
    }

    private func stat(_ text: String, strong: Bool) -> some View {
        Text(text)
            .font((compact ? PerpetoFont.small : PerpetoFont.caption).monospacedDigit())
            .foregroundStyle(strong ? PerpetoColor.ink : PerpetoColor.muted)
            .lineLimit(1)
    }

    private var meta: String {
        let c = node.config
        switch node.type {
        case .input: return (c["source"]?.stringValue ?? "manual") == "goals" ? "From project goals" : "Manual input"
        case .planner, .agent, .review:
            // The stat line shows concurrency on the live map; here the model is enough.
            return node.harness.map { Format.model($0.model) } ?? node.type.title
        case .ci: return Format.plural(c["steps"]?.arrayValue?.count ?? 0, "step") + ((c["requirements"]?["os"]?.stringValue).map { " on \($0)" } ?? "")
        case .mergeQueue:
            if let queue = c["queue"]?.stringValue, !queue.isEmpty { return "Project queue \(queue)" }
            return [(c["strategy"]?.stringValue ?? "serial").capitalized, c["method"]?.stringValue].compactMap { $0 }.joined(separator: " · ")
        case .loop: return "Up to \(c["maxIterations"]?.intValue ?? 0) rounds"
        case .human: return "Waits for a person"
        case .output: return "Work item finished"
        case .unknown: return "Unrecognised step"
        }
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
}
