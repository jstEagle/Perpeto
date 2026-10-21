import PerpetoKit
import SwiftUI

/// Hand editor for a workflow version. Saving creates a new draft version;
/// versions are immutable once saved.
struct WorkflowEditorView: View {
    var store: FactoryStore
    @State var workflow: Workflow
    var onClose: (Workflow?) -> Void

    @State private var selection: GraphSelection?
    @State private var roleEdgeKind: GraphEdge.Kind = .messages
    @State private var hubValidation: ValidationResult?
    @State private var saving = false

    private var validation: ValidationResult { hubValidation ?? WorkflowValidator.validate(workflow.graph) }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Rule()
            HStack(spacing: 0) {
                GraphViewport(
                    graph: workflow.graph, mode: .edit(issues: validation.issues), selection: $selection, editable: true,
                    connectKind: roleEdgeKind,
                    onMove: { id, position in
                        if let i = workflow.graph.nodes.firstIndex(where: { $0.id == id }) { workflow.graph.nodes[i].position = position }
                    },
                    onConnect: connect)
                    .padding(PerpetoSpacing.x(4))
                    .focusable()
                    .focusEffectDisabled()
                    #if os(macOS)
                    .onDeleteCommand(perform: deleteSelection)
                    #else
                    .onKeyPress(.delete) { deleteSelection(); return .handled }
                    #endif
                Rule(vertical: true)
                inspector
                    .frame(width: 320)
                    .background(PerpetoColor.surface)
            }
        }
        .onChange(of: workflow.graph) { _, _ in hubValidation = nil }
    }

    private var toolbar: some View {
        HStack(spacing: PerpetoSpacing.x(3)) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Editing \(workflow.name)").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                Text("Based on version \(workflow.version). Saving creates version \((store.state(workflow.projectId).versions[workflow.id]?.map(\.version).max() ?? workflow.version) + 1) as a draft.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
            Spacer()
            Menu {
                ForEach(NodeType.palette, id: \.self) { type in
                    Button { add(type) } label: { Label(type.title, systemImage: type.systemImage) }
                }
            } label: {
                Label("Add node", systemImage: "plus")
            }
            .fixedSize()
            .help("Add a node to the graph")
            Picker("Role edges", selection: $roleEdgeKind) {
                Text("Delegates").tag(GraphEdge.Kind.delegates)
                Text("Messages").tag(GraphEdge.Kind.messages)
            }
            .pickerStyle(.segmented)
            .fixedSize()
            .help("Kind of edge created when dragging from a role port")
            validationLabel
            Button("Cancel") { onClose(nil) }
                .buttonStyle(.perpetoSecondary)
                .keyboardShortcut(.cancelAction)
            Button(saving ? "Saving" : "Save as draft") {
                Task {
                    saving = true
                    defer { saving = false }
                    hubValidation = await store.validate(workflow)
                    guard validation.valid else { return }
                    if let saved = await store.save(workflow) { onClose(saved) }
                }
            }
            .buttonStyle(.perpetoPrimary)
            .keyboardShortcut("s", modifiers: .command)
            .disabled(!validation.valid || saving)
        }
        .padding(.horizontal, PerpetoSpacing.x(4))
        .padding(.vertical, PerpetoSpacing.x(3))
        .background(PerpetoColor.surface)
    }

    private var validationLabel: some View {
        let result = validation
        return Group {
            if result.valid && result.warningCount == 0 {
                StatusLabel("Valid", tone: .success)
            } else if result.valid {
                StatusLabel("Valid, \(Format.plural(result.warningCount, "warning"))", tone: .warning)
            } else {
                StatusLabel(Format.plural(result.errorCount, "error"), tone: .error)
            }
        }
        .frame(minWidth: 110, alignment: .trailing)
    }

    @ViewBuilder
    private var inspector: some View {
        if let id = selection?.nodeId, let index = workflow.graph.nodes.firstIndex(where: { $0.id == id }) {
            NodeInspector(node: $workflow.graph.nodes[index], issues: validation.issues.filter { $0.nodeId == id }) { deleteSelection() }
        } else if let id = selection?.edgeId, let edge = workflow.graph.edges.first(where: { $0.id == id }) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    EdgeInspector(edge: edge, graph: workflow.graph, metric: nil, delete: deleteSelection)
                    ForEach(validation.issues.filter { $0.edgeId == id }) { IssueRow(issue: $0).padding(.horizontal, PerpetoSpacing.x(4)) }
                }
            }
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                    Text("Validation").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                    if validation.issues.isEmpty {
                        Text("No problems found. The hub validates again when you save.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                    }
                    ForEach(validation.issues) { issue in
                        Button {
                            selection = issue.nodeId.map(GraphSelection.node) ?? issue.edgeId.map(GraphSelection.edge)
                        } label: { IssueRow(issue: issue) }
                        .buttonStyle(.plain)
                    }
                    Rule()
                    Text("How to edit").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                    Text("Drag nodes to move them; they snap to the 16 pt grid. Drag from a right-side port to another node to add a flow edge. Drag from the diamond under an agent role to add a delegates or messages edge. Press Delete to remove the selection.")
                        .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                }
                .padding(PerpetoSpacing.x(4))
            }
        }
    }

    private func add(_ type: NodeType) {
        var n = 1
        while workflow.graph.nodes.contains(where: { $0.id == "\(type.rawValue)-\(n)" }) { n += 1 }
        let maxX = workflow.graph.nodes.map(\.position.x).max() ?? 0
        var config: JSONValue = [:]
        if type.isAgentRole { config["harness"] = ["provider": "claudeAgent", "model": "claude-sonnet-5-5"] }
        if type == .agent || type == .review { config["concurrency"] = 1 }
        if type == .loop { config = ["until": "review-pass", "maxIterations": 3] }
        if type == .mergeQueue { config = ["strategy": "serial", "method": "squash"] }
        let node = GraphNode(id: "\(type.rawValue)-\(n)", type: type, label: type.title, position: .init(x: GraphLayout.snap(maxX + 188), y: 320), config: config)
        workflow.graph.nodes.append(node)
        selection = .node(node.id)
    }

    private func connect(_ from: GraphEdge.Endpoint, _ to: GraphEdge.Endpoint, _ kind: GraphEdge.Kind) {
        guard !workflow.graph.edges.contains(where: { $0.from == from && $0.to == to && $0.kind == kind }) else { return }
        var n = workflow.graph.edges.count + 1
        while workflow.graph.edges.contains(where: { $0.id == "e\(n)" }) { n += 1 }
        let edge = GraphEdge(id: "e\(n)", from: from, to: to, kind: kind)
        workflow.graph.edges.append(edge)
        selection = .edge(edge.id)
    }

    private func deleteSelection() {
        switch selection {
        case .node(let id):
            workflow.graph.nodes.removeAll { $0.id == id }
            workflow.graph.edges.removeAll { $0.from.node == id || $0.to.node == id }
        case .edge(let id):
            workflow.graph.edges.removeAll { $0.id == id }
        case nil: return
        }
        selection = nil
    }
}
