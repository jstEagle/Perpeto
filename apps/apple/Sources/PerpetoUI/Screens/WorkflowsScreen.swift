import PerpetoKit
import SwiftUI

/// Workflows start from a prompt. The workflow architect drafts a graph,
/// the person reviews its rationale and diff, then activates it, asks for
/// changes, or edits by hand.
struct WorkflowsScreen: View {
    var store: FactoryStore
    @Bindable var navigator: Navigator
    var project: Project
    var state: ProjectState

    @State private var prompt = ""
    @State private var composingNew = false
    @State private var viewingVersion: Int?
    @State private var editing: Workflow?
    @State private var selection: GraphSelection?
    @FocusState private var promptFocused: Bool

    private var workflowId: String? {
        if composingNew { return nil }
        if let id = navigator.selectedWorkflowId, state.versions[id] != nil { return id }
        return state.workflows.first?.id
    }

    private var draftProgress: DraftProgress? { store.drafts[project.id] }

    var body: some View {
        if let editing {
            WorkflowEditorView(store: store, workflow: editing) { saved in
                self.editing = nil
                if let saved { viewingVersion = saved.version }
            }
        } else if state.workflows.isEmpty || composingNew {
            composer
        } else if let workflowId {
            workflowDetail(workflowId)
        }
    }

    // MARK: Prompt-first composer

    private var composer: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
                if composingNew && !state.workflows.isEmpty {
                    Button { composingNew = false } label: { Label("Back to workflows", systemImage: "chevron.left") }
                        .buttonStyle(.perpetoGhost)
                }
                Text("Describe how this project should be built")
                    .font(PerpetoFont.display())
                    .displayTracking()
                    .foregroundStyle(PerpetoColor.ink)
                Text("The workflow architect drafts a graph of agents, review, CI and merging from your description. Nothing runs until you activate it.")
                    .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                    .frame(maxWidth: 620, alignment: .leading)
                PromptBox(text: $prompt, focused: $promptFocused, placeholder: "For example: plan work from our goals, build with Codex, review every PR with Claude, run CI on our Linux box, and merge one at a time.", minHeight: 120)
                ArchitectContext(project: project, machines: store.factory.machines, workflows: state.workflows.count)
                HStack {
                    Button("Draft workflow") { submit(base: nil) }
                        .buttonStyle(.perpetoPrimary)
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draftProgress?.stage.isWorking == true)
                    Text("⌘↩").font(PerpetoFont.mono()).foregroundStyle(PerpetoColor.muted)
                }
                if let progress = draftProgress {
                    ArchitectProgressView(progress: progress) {
                        store.clearDraft(projectId: project.id)
                        if let draft = progress.draft {
                            composingNew = false
                            navigator.selectedWorkflowId = draft.id
                            viewingVersion = nil
                        }
                    }
                }
            }
            .padding(PerpetoSpacing.x(10))
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .onAppear { promptFocused = true }
        .onChange(of: navigator.composeWorkflowRequest) { _, _ in promptFocused = true }
    }

    private func submit(base: String?) {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        store.requestDraft(projectId: project.id, prompt: text, baseWorkflowId: base)
        prompt = ""
    }

    // MARK: Workflow detail

    @ViewBuilder
    private func workflowDetail(_ id: String) -> some View {
        let versions = state.versions[id] ?? []
        let active = state.activeVersion(of: id)
        let pending = state.pendingDraft(of: id)
        let shown = viewingVersion.flatMap { v in versions.first { $0.version == v } } ?? pending ?? active ?? versions.last
        VStack(alignment: .leading, spacing: 0) {
            header(id: id, active: active)
                .padding(.horizontal, PerpetoSpacing.x(6))
                .padding(.top, PerpetoSpacing.x(5))
                .padding(.bottom, PerpetoSpacing.x(4))
            askBar(id: id, name: active?.name ?? shown?.name ?? "this workflow")
                .padding(.horizontal, PerpetoSpacing.x(6))
                .padding(.bottom, PerpetoSpacing.x(4))
            if let progress = draftProgress {
                ArchitectProgressView(progress: progress) {
                    store.clearDraft(projectId: project.id)
                    if let draft = progress.draft { viewingVersion = draft.version }
                }
                .padding(.horizontal, PerpetoSpacing.x(6))
                .padding(.bottom, PerpetoSpacing.x(4))
            }
            if let shown {
                let base = shown.status == .active ? nil : (active ?? shown.parentVersion.flatMap { p in versions.first { $0.version == p } })
                let diff = base.map { WorkflowDiff(from: $0, to: shown) }
                HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                        if let diff, let base {
                            DiffSummary(diff: diff, baseVersion: base.version)
                        }
                        GraphViewport(graph: shown.graph, mode: diff.map { .diff($0) } ?? .view, selection: $selection)
                    }
                    VersionPanel(
                        store: store, shown: shown, active: active, versions: versions, diff: diff,
                        select: { viewingVersion = $0 },
                        activate: { Task { await store.activate(shown); viewingVersion = nil } },
                        askForChanges: { promptFocused = true },
                        editByHand: { editing = shown },
                        startRun: { Task { await store.startRun(projectId: project.id, workflowId: id) ; navigator.route = .project(project.id, .runs) } },
                        selection: selection, graph: shown.graph)
                        .frame(width: 340)
                }
                .padding(.horizontal, PerpetoSpacing.x(6))
                .padding(.bottom, PerpetoSpacing.x(6))
            }
        }
        .onChange(of: navigator.composeWorkflowRequest) { _, _ in composingNew = true }
        .onChange(of: navigator.editWorkflowRequest) { _, _ in editing = shown }
    }

    private func header(id: String, active: Workflow?) -> some View {
        ScreenHeader("Workflows", subtitle: "How work moves through \(project.name): agents, review, CI and merging.") {
            if state.workflows.count > 1 {
                Picker("Workflow", selection: Binding(get: { id }, set: { navigator.selectedWorkflowId = $0; viewingVersion = nil; selection = nil })) {
                    ForEach(state.workflows) { w in Text(w.name).tag(w.id) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
            }
            Button("New workflow") { composingNew = true }
                .buttonStyle(.perpetoSecondary)
                .help("Describe a new workflow for the architect (⌘N)")
        }
    }

    private func askBar(id: String, name: String) -> some View {
        HStack(alignment: .center, spacing: PerpetoSpacing.x(3)) {
            SpindleShape().fill(PerpetoColor.muted).frame(width: 14, height: 14)
            TextField("Ask the architect for changes to \(name)", text: $prompt, axis: .vertical)
                .textFieldStyle(.plain)
                .font(PerpetoFont.body)
                .lineLimit(1...3)
                .focused($promptFocused)
                .onSubmit { submit(base: id) }
            Button("Draft changes") { submit(base: id) }
                .buttonStyle(.perpetoPrimary)
                .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draftProgress?.stage.isWorking == true)
        }
        .padding(.leading, PerpetoSpacing.x(3))
        .padding(.trailing, PerpetoSpacing.x(2))
        .padding(.vertical, PerpetoSpacing.x(2))
        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.panel))
        .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.panel).strokeBorder(PerpetoColor.controlBorder))
        .focusOutline(promptFocused, radius: PerpetoRadius.panel)
    }
}

extension DraftProgress.Stage {
    var isWorking: Bool { self < .ready }
}

struct PromptBox: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    var placeholder: String
    var minHeight: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder).font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $text)
                .font(PerpetoFont.body)
                .foregroundStyle(PerpetoColor.ink)
                .scrollContentBackground(.hidden)
                .scrollIndicators(.never)
                .focusEffectDisabled()
                .focused(focused)
        }
        .frame(minHeight: minHeight)
        .padding(PerpetoSpacing.x(3))
        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.panel))
        .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.panel).strokeBorder(PerpetoColor.controlBorder))
        .focusOutline(focused.wrappedValue, radius: PerpetoRadius.panel)
    }
}

/// What the architect will read, so the person knows its context.
struct ArchitectContext: View {
    var project: Project
    var machines: [Machine]
    var workflows: Int

    var body: some View {
        let online = machines.filter { $0.status == .online }
        let providers = Set(online.flatMap(\.providers)).sorted().map(Format.provider)
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            Text("The architect reads").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
            HStack(spacing: PerpetoSpacing.x(2)) {
                Tag(Format.plural(project.docs.count, "doc"), systemImage: "doc.text")
                Tag(Format.plural(project.goals.count, "goal"), systemImage: "scope")
                Tag(Format.plural(online.count, "online machine"), systemImage: "desktopcomputer")
                if !providers.isEmpty { Tag(providers.joined(separator: ", "), systemImage: "cpu") }
                if workflows > 0 { Tag(Format.plural(workflows, "existing workflow"), systemImage: "point.3.connected.trianglepath.dotted") }
            }
        }
    }
}

/// Explicit stage labels; the only motion is the brief Spindle loader.
struct ArchitectProgressView: View {
    var progress: DraftProgress
    var dismiss: () -> Void

    private let stages: [DraftProgress.Stage] = [.queued, .reading, .drafting, .validating, .ready]

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            HStack(spacing: PerpetoSpacing.x(2)) {
                if progress.stage.isWorking { SpindleLoader(size: 16) } else {
                    SpindleShape().fill(progress.stage == .failed ? PerpetoColor.error : PerpetoColor.ink).frame(width: 16, height: 16)
                }
                Text(progress.stage.isWorking ? "Workflow architect is working" : progress.stage.title)
                    .font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                if let id = progress.assignmentId { Mono(id) }
                Spacer()
                if !progress.stage.isWorking {
                    Button(progress.draft == nil ? "Dismiss" : "Review draft", action: dismiss)
                        .buttonStyle(progress.draft == nil ? AnyButtonStyle(.perpetoSecondary) : AnyButtonStyle(.perpetoPrimary))
                }
            }
            HStack(spacing: 0) {
                ForEach(Array(stages.enumerated()), id: \.offset) { index, stage in
                    if index > 0 {
                        Rectangle().fill(stage <= progress.stage && progress.stage != .failed ? PerpetoColor.ink : PerpetoColor.border)
                            .frame(height: 1).frame(maxWidth: 24)
                    }
                    StatusLabel(stage.title, tone: tone(stage))
                        .padding(.horizontal, PerpetoSpacing.x(1))
                }
            }
            if let detail = progress.detail {
                Text(detail).font(PerpetoFont.body).foregroundStyle(PerpetoColor.error)
            }
            if progress.attempt > 1 {
                Text("Attempt \(progress.attempt) of 3: the previous graph did not validate.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
        }
        .panel()
    }

    private func tone(_ stage: DraftProgress.Stage) -> StatusTone {
        if progress.stage == .failed { return stage == .queued ? .neutral : .error }
        if stage < progress.stage || progress.stage == .ready { return .success }
        if stage == progress.stage { return .running }
        return .neutral
    }
}

struct AnyButtonStyle: ButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: ButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}

struct DiffSummary: View {
    var diff: WorkflowDiff
    var baseVersion: Int

    var body: some View {
        HStack(spacing: PerpetoSpacing.x(3)) {
            Text("Compared with version \(baseVersion)").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
            if diff.isEmpty {
                Text("No behavioral changes").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            } else {
                change(diff.count(.added), "node", "added", .added)
                change(diff.count(.changed), "node", "changed", .changed)
                change(diff.count(.removed), "node", "removed", .removed)
                change(diff.edgeCount(.added), "edge", "added", .added)
                change(diff.edgeCount(.removed), "edge", "removed", .removed)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func change(_ count: Int, _ noun: String, _ verb: String, _ kind: WorkflowDiff.Change) -> some View {
        if count > 0 { Tag("\(Format.plural(count, noun)) \(verb)", color: kind.color) }
    }
}

/// Selected version, its authorship and rationale, actions and history.
struct VersionPanel: View {
    var store: FactoryStore
    var shown: Workflow
    var active: Workflow?
    var versions: [Workflow]
    var diff: WorkflowDiff?
    var select: (Int) -> Void
    var activate: () -> Void
    var askForChanges: () -> Void
    var editByHand: () -> Void
    var startRun: () -> Void
    var selection: GraphSelection?
    var graph: WorkflowGraph

    var body: some View {
        let validation = WorkflowValidator.validate(shown.graph)
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Text(shown.status == .draft && shown.version > (active?.version ?? 0) ? "Version \(shown.version) proposal" : "Version \(shown.version)")
                        .font(PerpetoFont.title(PerpetoType.text16)).foregroundStyle(PerpetoColor.ink)
                    Spacer()
                    StatusLabel(statusLabel(shown))
                }
                AuthorLine(workflow: shown)
                if let prompt = shown.authoredBy?.prompt {
                    Text(prompt)
                        .font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink)
                        .padding(PerpetoSpacing.x(3))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(PerpetoColor.canvas, in: RoundedRectangle(cornerRadius: PerpetoRadius.control))
                        .overlay(alignment: .leading) { Rectangle().fill(PerpetoColor.controlBorder).frame(width: 2) }
                }
                if let rationale = shown.rationale {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
                        Text("Rationale").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                        Text(rationale).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let diff, !diff.isEmpty { changeList(diff) }
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Text("Validation").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
                    StatusLabel(validation.valid ? "Valid" : Format.plural(validation.errorCount, "error"), tone: validation.valid ? .success : .error)
                }
                actions(validation: validation)
                Rule()
                selectionDetail
                history
            }
            .padding(PerpetoSpacing.x(4))
        }
        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.panel))
        .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.panel).strokeBorder(PerpetoColor.border))
    }

    private func statusLabel(_ w: Workflow) -> (String, StatusTone) {
        if w.status == .active { return ("Active", .success) }
        if w.status == .paused { return ("Paused", .warning) }
        if w.version < (active?.version ?? 0) { return ("Superseded", .neutral) }
        return ("Draft", .neutral)
    }

    @ViewBuilder
    private func actions(validation: ValidationResult) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            if shown.status != .active {
                Button("Activate version \(shown.version)", action: activate)
                    .buttonStyle(.perpetoPrimary)
                    .disabled(!validation.valid)
                Text(active.map { "Runs already in progress keep version \($0.version). New runs use the active version." } ?? "Nothing runs until you activate a version.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                Button("Start a run", action: startRun).buttonStyle(.perpetoPrimary)
            }
            HStack(spacing: PerpetoSpacing.x(2)) {
                Button("Ask for changes", action: askForChanges).buttonStyle(.perpetoSecondary)
                Button("Edit by hand", action: editByHand).buttonStyle(.perpetoGhost)
            }
        }
    }

    private func changeList(_ diff: WorkflowDiff) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
            Text("Changes").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
            ForEach(diff.nodes.filter { $0.value != .unchanged }.sorted { $0.key < $1.key }, id: \.key) { id, change in
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Tag(change.title, color: change.color).frame(width: 74, alignment: .leading)
                    Text(graph.node(id)?.label ?? diff.removedNodes.first { $0.id == id }?.label ?? id).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink)
                    Spacer()
                    Mono(id)
                }
            }
            ForEach(graph.edges.filter { diff.edges[$0.id] == .added }) { edge in
                edgeRow(edge, change: .added)
            }
            ForEach(diff.removedEdges) { edge in
                edgeRow(edge, change: .removed)
            }
        }
    }

    private func edgeRow(_ edge: GraphEdge, change: WorkflowDiff.Change) -> some View {
        let name = { (id: String) in graph.node(id)?.label ?? id }
        return HStack(spacing: PerpetoSpacing.x(2)) {
            Tag(change.title, color: change.color).frame(width: 74, alignment: .leading)
            Text("\(EdgeStyle.title(edge.kind)): \(name(edge.from.node)) → \(name(edge.to.node))")
                .font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).lineLimit(1)
        }
    }

    @ViewBuilder
    private var selectionDetail: some View {
        if let id = selection?.nodeId, let node = graph.node(id) {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
                Text(node.label).font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                ConfigList(config: node.config)
            }
            Rule()
        } else if let id = selection?.edgeId, let edge = graph.edges.first(where: { $0.id == id }) {
            EdgeInspector(edge: edge, graph: graph, metric: nil, delete: nil).padding(-PerpetoSpacing.x(4))
            Rule()
        }
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Version history").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink).padding(.bottom, PerpetoSpacing.x(2))
            ForEach(versions.reversed(), id: \.version) { version in
                Button { select(version.version) } label: {
                    HStack(alignment: .top, spacing: PerpetoSpacing.x(3)) {
                        Text("v\(version.version)").font(PerpetoFont.mono(PerpetoType.text14)).foregroundStyle(PerpetoColor.ink).frame(width: 28, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            AuthorLine(workflow: version, compact: true)
                            if let date = version.createdAt {
                                Text(Format.relative(date)).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                            }
                        }
                        Spacer()
                        StatusLabel(statusLabel(version))
                    }
                    .padding(.vertical, PerpetoSpacing.x(2))
                    .padding(.horizontal, PerpetoSpacing.x(2))
                    .background(version.version == shown.version ? PerpetoColor.canvas : .clear, in: RoundedRectangle(cornerRadius: PerpetoRadius.control))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct AuthorLine: View {
    var workflow: Workflow
    var compact = false

    var body: some View {
        HStack(spacing: PerpetoSpacing.x(1.5)) {
            Image(systemName: workflow.authoredBy?.kind == .agent ? "sparkle.magnifyingglass" : "person")
                .font(.system(size: 11)).foregroundStyle(PerpetoColor.muted)
            Text(text).font(compact ? PerpetoFont.caption : PerpetoFont.body).foregroundStyle(compact ? PerpetoColor.ink : PerpetoColor.muted)
            if !compact, let id = workflow.authoredBy?.assignmentId { Mono(id) }
        }
    }

    private var text: String {
        switch workflow.authoredBy?.kind {
        case .agent: workflow.authoredBy?.prompt?.hasPrefix("Proposed by") == true ? "Proposed by a running agent" : "Drafted by the architect"
        case .user: "Edited by hand"
        default: "Author not recorded"
        }
    }
}

/// Read-only rendering of node config.
struct ConfigList: View {
    var config: JSONValue

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            ForEach((config.objectValue ?? [:]).sorted { $0.key < $1.key }, id: \.key) { key, value in
                HStack(alignment: .firstTextBaseline) {
                    Text(key).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).frame(width: 96, alignment: .leading)
                    Text(render(value)).font(PerpetoFont.mono()).foregroundStyle(PerpetoColor.ink).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func render(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): s
        case .number(let n): n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): b ? "true" : "false"
        case .null: "null"
        case .array(let a): a.map(render).joined(separator: ", ")
        case .object(let o): o.sorted { $0.key < $1.key }.map { "\($0.key): \(render($0.value))" }.joined(separator: "; ")
        }
    }
}
