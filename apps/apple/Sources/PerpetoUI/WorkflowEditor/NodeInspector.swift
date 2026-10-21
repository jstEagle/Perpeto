import PerpetoKit
import SwiftUI

/// Typed configuration for the selected node, per the node-type table in
/// docs/architecture/README.md "Workflow graph v1".
struct NodeInspector: View {
    @Binding var node: GraphNode
    var issues: [ValidationIssue]
    var delete: () -> Void

    static let providers = ["claudeAgent", "codex"]
    static let models = ["claudeAgent": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], "codex": ["gpt-5-codex", "gpt-5"]]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Image(systemName: node.type.systemImage).foregroundStyle(PerpetoColor.muted)
                    Text(node.type.title).font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                    Spacer()
                    Mono(node.id)
                }
                field("Label") { TextField("Label", text: $node.label).perpetoField() }

                switch node.type {
                case .input:
                    field("Source") {
                        picker(key: "source", options: ["manual", "goals", "issues"], titles: ["Manual", "Project goals", "Issues"])
                    }
                case .planner:
                    harnessFields
                    promptField
                    field("Most items per input") { stepper(key: "maxItems", range: 1...50) }
                case .agent:
                    harnessFields
                    promptField
                    field("Concurrency") { stepper(key: "concurrency", range: 1...32) }
                    policyFields
                case .review:
                    harnessFields
                    promptField
                    field("Concurrency") { stepper(key: "concurrency", range: 1...16) }
                    field("Rubric") { textEditor(key: "rubric") }
                case .ci:
                    stepsField
                    field("Machine OS") { picker(key: "requirements.os", options: ["", "darwin", "linux", "windows"], titles: ["Any", "macOS", "Linux", "Windows"]) }
                case .mergeQueue:
                    field("Strategy") { picker(key: "strategy", options: ["serial", "batch"], titles: ["Serial", "Batch"]) }
                    field("Merge method") { picker(key: "method", options: ["squash", "merge", "rebase"], titles: ["Squash", "Merge", "Rebase"]) }
                case .loop:
                    field("Repeat until") { picker(key: "until", options: ["review-pass", "ci-pass", "manual"], titles: ["Review passes", "CI passes", "A person decides"]) }
                    field("Most iterations") { stepper(key: "maxIterations", range: 1...10) }
                    Text("An item that reaches the limit fails, so loops always end.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                case .human:
                    promptField
                case .output, .unknown:
                    Text("Terminal node. Work items that arrive here are finished.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                }

                if !issues.isEmpty {
                    Rule()
                    ForEach(issues) { IssueRow(issue: $0) }
                }
                Rule()
                Button(role: .destructive, action: delete) {
                    Label("Delete node", systemImage: "trash")
                }
                .buttonStyle(.perpetoGhost)
                .foregroundStyle(PerpetoColor.error)
            }
            .padding(PerpetoSpacing.x(4))
        }
    }

    // MARK: Groups

    @ViewBuilder
    private var harnessFields: some View {
        let provider = node.config["harness"]?["provider"]?.stringValue ?? Self.providers[0]
        field("Harness") {
            Picker("Provider", selection: Binding(
                get: { provider },
                set: { node.config["harness"] = ["provider": .string($0), "model": .string(Self.models[$0]?.first ?? "")] })
            ) {
                ForEach(Self.providers, id: \.self) { Text(Format.provider($0)).tag($0) }
            }
            .labelsHidden()
            Picker("Model", selection: Binding(
                get: { node.config["harness"]?["model"]?.stringValue ?? "" },
                set: { node.config["harness"] = ["provider": .string(provider), "model": .string($0)] })
            ) {
                ForEach(Self.models[provider] ?? [], id: \.self) { Text($0).font(PerpetoFont.mono()).tag($0) }
            }
            .labelsHidden()
        }
    }

    private var promptField: some View {
        field("Prompt") { textEditor(key: "prompt") }
    }

    @ViewBuilder
    private var policyFields: some View {
        field("Most subagents") {
            Stepper(value: Binding(
                get: { node.config["policy"]?["maxSubagents"]?.intValue ?? 0 },
                set: { setPolicy("maxSubagents", .number(Double($0))) }), in: 0...8) {
                Text("\(node.config["policy"]?["maxSubagents"]?.intValue ?? 0)").font(PerpetoFont.body.monospacedDigit())
            }
        }
        field("Subagent providers") {
            ForEach(Self.providers, id: \.self) { provider in
                let allowed = node.config["policy"]?["allowedSubagentProviders"]?.arrayValue?.compactMap(\.stringValue) ?? []
                Toggle(Format.provider(provider), isOn: Binding(
                    get: { allowed.contains(provider) },
                    set: { on in
                        var next = allowed.filter { $0 != provider }
                        if on { next.append(provider) }
                        setPolicy("allowedSubagentProviders", .array(next.map(JSONValue.string)))
                    }))
                #if os(macOS)
                .toggleStyle(.checkbox)
                #endif
            }
        }
    }

    private func setPolicy(_ key: String, _ value: JSONValue) {
        var policy = node.config["policy"] ?? [:]
        policy[key] = value
        node.config["policy"] = policy
    }

    private var stepsField: some View {
        field("Steps") {
            let steps = node.config["steps"]?.arrayValue ?? []
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                    HStack {
                        Text(step["name"]?.stringValue ?? "Step").font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).frame(width: 70, alignment: .leading)
                        TextField("Command", text: Binding(
                            get: { step["run"]?.stringValue ?? "" },
                            set: { value in
                                var all = steps
                                all[index]["run"] = .string(value)
                                node.config["steps"] = .array(all)
                            }))
                            .font(PerpetoFont.mono())
                            .perpetoField()
                        Button { var all = steps; all.remove(at: index); node.config["steps"] = .array(all) } label: { Image(systemName: "minus.circle") }
                            .buttonStyle(.plain).foregroundStyle(PerpetoColor.muted)
                            .help("Remove step")
                    }
                }
                Button("Add step") {
                    node.config["steps"] = .array(steps + [["name": .string("Step \(steps.count + 1)"), "run": ""]])
                }
                .buttonStyle(.perpetoSecondary)
            }
        }
    }

    // MARK: Controls

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
            Text(label).font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
            content()
        }
    }

    private func picker(key: String, options: [String], titles: [String]) -> some View {
        let path = key.split(separator: ".").map(String.init)
        return Picker(key, selection: Binding(
            get: { path.count == 2 ? (node.config[path[0]]?[path[1]]?.stringValue ?? "") : (node.config[key]?.stringValue ?? options[0]) },
            set: { value in
                if path.count == 2 {
                    var group = node.config[path[0]] ?? [:]
                    group[path[1]] = value.isEmpty ? nil : .string(value)
                    node.config[path[0]] = group
                } else {
                    node.config[key] = .string(value)
                }
            })
        ) {
            ForEach(Array(zip(options, titles)), id: \.0) { Text($0.1).tag($0.0) }
        }
        .labelsHidden()
    }

    private func stepper(key: String, range: ClosedRange<Int>) -> some View {
        let value = node.config[key]?.intValue ?? range.lowerBound
        return Stepper(value: Binding(get: { value }, set: { node.config[key] = .number(Double($0)) }), in: range) {
            Text("\(value)").font(PerpetoFont.body.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
        }
    }

    private func textEditor(key: String) -> some View {
        TextEditor(text: Binding(get: { node.config[key]?.stringValue ?? "" }, set: { node.config[key] = .string($0) }))
            .font(PerpetoFont.body)
            .scrollContentBackground(.hidden)
            .frame(minHeight: 72)
            .padding(PerpetoSpacing.x(1))
            .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.control).strokeBorder(PerpetoColor.controlBorder))
    }
}

struct IssueRow: View {
    var issue: ValidationIssue

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(2)) {
            Image(systemName: issue.severity == .error ? "xmark.octagon" : "exclamationmark.triangle")
                .foregroundStyle(issue.severity == .error ? PerpetoColor.error : PerpetoColor.warning)
                .font(.system(size: 12))
            VStack(alignment: .leading, spacing: 2) {
                Text(issue.message).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).fixedSize(horizontal: false, vertical: true)
                Text(issue.severity == .error ? "Error" : "Warning").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
        }
    }
}

struct EdgeInspector: View {
    var edge: GraphEdge
    var graph: WorkflowGraph
    var metric: EdgeMetrics?
    var delete: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            HStack {
                Text(EdgeStyle.title(edge.kind) + " edge").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                Spacer()
                Mono(edge.id)
            }
            Text(EdgeStyle.meaning(edge.kind)).font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
            HStack(spacing: PerpetoSpacing.x(2)) {
                Text(graph.node(edge.from.node)?.label ?? edge.from.node).font(PerpetoFont.bodyMedium)
                if let port = edge.from.port, port != "role" { Tag(port, color: port == "fail" ? PerpetoColor.error : PerpetoColor.success) }
                Image(systemName: "arrow.right").foregroundStyle(PerpetoColor.muted)
                Text(graph.node(edge.to.node)?.label ?? edge.to.node).font(PerpetoFont.bodyMedium)
            }
            .foregroundStyle(PerpetoColor.ink)
            if let metric {
                Figure("Traffic in window", value: "\(metric.count)")
            }
            if let delete {
                Button(role: .destructive, action: delete) { Label("Delete edge", systemImage: "trash") }
                    .buttonStyle(.perpetoGhost).foregroundStyle(PerpetoColor.error)
            }
        }
        .padding(PerpetoSpacing.x(4))
    }
}
