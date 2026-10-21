import PerpetoKit
import SwiftUI

/// Workflows start from a prompt. The workflow architect drafts a graph,
/// the person reviews its rationale and changes, then activates it, asks for
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
    @Environment(\.compactLayout) private var compact

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
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader(
                    "Describe how this project should be built",
                    subtitle: "The workflow architect drafts the steps, reviews, checks and merging from your description. Nothing runs until you activate it.",
                    back: composingNew && !state.workflows.isEmpty ? ("Workflows", { composingNew = false }) : nil)
                    .frame(maxWidth: PerpetoLayout.readingMax + 120, alignment: .leading)
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
                    PromptBox(text: $prompt, focused: $promptFocused,
                              placeholder: "For example: plan work from our goals, build with Codex, review every pull request with Claude, run CI on the Linux machine and merge one at a time.",
                              minHeight: 132)
                    ArchitectContext(project: project, machines: store.factory.machines, workflows: state.workflows.count)
                    Button("Draft workflow") { submit(base: nil) }
                        .buttonStyle(.perpetoPrimary)
                        .controlSize(.large)
                        .fullWidthButtons(compact)
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draftProgress?.stage.isWorking == true)
                }
                .card()
                .frame(maxWidth: PerpetoLayout.readingMax + 120, alignment: .leading)
                if let progress = draftProgress {
                    ArchitectProgressView(progress: progress) {
                        store.clearDraft(projectId: project.id)
                        if let draft = progress.draft {
                            composingNew = false
                            navigator.selectedWorkflowId = draft.id
                            viewingVersion = nil
                        }
                    }
                    .frame(maxWidth: PerpetoLayout.readingMax + 120, alignment: .leading)
                }
            }
            .screenPadding()
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
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                header(id: id, active: active, shown: shown)
                askBar(id: id, name: active?.name ?? shown?.name ?? "this workflow")
                if let progress = draftProgress {
                    ArchitectProgressView(progress: progress) {
                        store.clearDraft(projectId: project.id)
                        if let draft = progress.draft { viewingVersion = draft.version }
                    }
                }
                if let shown {
                    let base = shown.status == .active ? nil : (active ?? shown.parentVersion.flatMap { p in versions.first { $0.version == p } })
                    let diff = base.map { WorkflowDiff(from: $0, to: shown) }
                    let panel = VersionPanel(
                        store: store, shown: shown, active: active, versions: versions, diff: diff,
                        select: { viewingVersion = $0 },
                        activate: { Task { await store.activate(shown); viewingVersion = nil } },
                        askForChanges: { promptFocused = true },
                        editByHand: { editing = shown },
                        startRun: { Task { await store.startRun(projectId: project.id, workflowId: id); navigator.selectedRunId = nil; navigator.route = .project(project.id, .runs) } })
                    panel
                    if compact {
                        StepList(graph: shown.graph, live: nil, selection: $selection)
                    } else {
                        GraphViewport(graph: shown.graph, mode: diff.map { .diff($0) } ?? .view, selection: $selection)
                            .frame(height: min(640, max(380, GraphCanvas.layout(graph: shown.graph, mode: .view, include: { _ in false }).contentSize.height + 56)))
                    }
                    if let selection { SelectionDetail(graph: shown.graph, selection: selection) { self.selection = nil } }
                }
            }
            .screenPadding()
        }
        .onChange(of: navigator.composeWorkflowRequest) { _, _ in composingNew = true }
        .onChange(of: navigator.editWorkflowRequest) { _, _ in editing = shown }
    }

    private func header(id: String, active: Workflow?, shown: Workflow?) -> some View {
        let name = state.workflows.first { $0.id == id }?.name ?? "Workflow"
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            ScreenHeader(name, status: active.map { ("Active, v\($0.version)", .ok) } ?? ("Not active", .neutral), meta: {
                Text("How work moves through \(project.name): planning, building, review, checks and merging.")
            }) {
                Button("New workflow") { composingNew = true }
                    .buttonStyle(.perpetoSecondary)
                    .help("Describe a new workflow for the architect (⌘N)")
            }
            if state.workflows.count > 1 {
                PillPicker(state.workflows.map { ($0.id, $0.name) },
                           selection: Binding(get: { id }, set: { navigator.selectedWorkflowId = $0; viewingVersion = nil; selection = nil }))
            }
        }
    }

    /// A search-style pill: ask the architect for a change.
    private func askBar(id: String, name: String) -> some View {
        HStack(spacing: PerpetoSpacing.x(3)) {
            SpindleShape().fill(PerpetoColor.muted).frame(width: 16, height: 16)
            TextField("Ask the architect for changes to \(name)", text: $prompt, axis: .vertical)
                .textFieldStyle(.plain)
                .font(PerpetoFont.body)
                .lineLimit(1...3)
                .focused($promptFocused)
                .onSubmit { submit(base: id) }
            Button("Draft changes") { submit(base: id) }
                .buttonStyle(.perpetoSecondary)
                .controlSize(.small)
                .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draftProgress?.stage.isWorking == true)
        }
        .padding(.leading, PerpetoSpacing.x(5))
        .padding(.trailing, PerpetoSpacing.x(2))
        .frame(minHeight: 52)
        .background(Capsule(style: .continuous).fill(PerpetoColor.surface))
        .pillElevation(.card, height: 52)
        .focusOutline(promptFocused, radius: 26)
    }
}

extension DraftProgress.Stage {
    var isWorking: Bool { self < .ready }
}

/// A large white field for the prompt.
struct PromptBox: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    var placeholder: String
    var minHeight: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder).perpetoBody(PerpetoType.text16, color: PerpetoColor.muted)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $text)
                .font(PerpetoType.text(PerpetoType.text16))
                .foregroundStyle(PerpetoColor.ink)
                .scrollContentBackground(.hidden)
                .scrollIndicators(.never)
                .focusEffectDisabled()
                .focused(focused)
        }
        .frame(minHeight: minHeight)
        .padding(PerpetoSpacing.x(4))
        .background(PerpetoColor.surfaceSubtle, in: RoundedRectangle(cornerRadius: PerpetoRadius.node, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.node, style: .continuous)
            .strokeBorder(focused.wrappedValue ? PerpetoColor.ink : .clear, lineWidth: 1.5))
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
        HStack(spacing: PerpetoSpacing.x(2)) {
            Text("The architect reads").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            Tag(Format.plural(project.docs.count, "doc"))
            Tag(Format.plural(project.goals.count, "goal"))
            Tag(Format.plural(online.count, "online machine"))
            if !providers.isEmpty { Tag(providers.joined(separator: ", ")) }
        }
    }
}

/// Explicit stages; the Spindle loader is the only motion while it works.
struct ArchitectProgressView: View {
    var progress: DraftProgress
    var dismiss: () -> Void

    private let stages: [DraftProgress.Stage] = [.queued, .reading, .drafting, .validating, .ready]

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            HStack(spacing: PerpetoSpacing.x(3)) {
                if progress.stage.isWorking { SpindleLoader(size: 20) } else { StatusIcon(progress.stage == .failed ? .error : .success, size: 20) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(progress.stage.isWorking ? "The workflow architect is drafting" : progress.stage.title)
                        .font(PerpetoType.text(PerpetoType.text16, weight: .medium)).foregroundStyle(PerpetoColor.ink)
                    Text(progress.stage.isWorking ? progress.stage.title : (progress.attempt > 1 ? "After \(progress.attempt) attempts" : "First attempt"))
                        .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                }
                Spacer()
                if !progress.stage.isWorking {
                    if progress.draft == nil {
                        Button("Dismiss", action: dismiss).buttonStyle(.perpetoSecondary)
                    } else {
                        Button("Review draft", action: dismiss).buttonStyle(.perpetoPrimary)
                    }
                }
            }
            HStack(spacing: PerpetoSpacing.x(1.5)) {
                ForEach(stages, id: \.self) { stage in
                    Capsule().fill(fill(stage)).frame(height: 4)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(progress.stage.title)
            if let detail = progress.detail {
                Text(detail).font(PerpetoFont.body).foregroundStyle(progress.stage == .failed ? PerpetoColor.error : PerpetoColor.muted)
            }
        }
        .card()
    }

    private func fill(_ stage: DraftProgress.Stage) -> Color {
        if progress.stage == .failed { return PerpetoColor.chartQuiet }
        return stage <= progress.stage ? PerpetoColor.ink : PerpetoColor.chartQuiet
    }
}

/// The version on screen: who wrote it and why, what changed, and the one
/// primary action. Older versions sit behind "Version history".
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

    /// The hub's workflow package is the authority; local checks show until it answers.
    @State private var hubValidation: (version: Int, result: ValidationResult)?
    @State private var showHistory = false
    @State private var showChanges = false
    @Environment(\.compactLayout) private var compact

    private var isProposal: Bool { shown.status != .active && shown.version > (active?.version ?? 0) }

    var body: some View {
        let validation = hubValidation.flatMap { $0.version == shown.version ? $0.result : nil } ?? WorkflowValidator.validate(shown.graph)
        VStack(alignment: .leading, spacing: PerpetoGap.cards) {
            Group {
                if compact {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
                        story
                        decision(validation)
                    }
                } else {
                    HStack(alignment: .top, spacing: PerpetoSpacing.x(10)) {
                        story.frame(maxWidth: PerpetoLayout.readingMax, alignment: .leading)
                        decision(validation).frame(width: 340, alignment: .leading)
                    }
                }
            }
            .card()
            if versions.count > 1 {
                Disclosure("Version history · \(versions.count)", isExpanded: $showHistory) { history }
                    .card()
            }
        }
        .task(id: "\(shown.id)@\(shown.version)") {
            let result = await store.validate(shown)
            hubValidation = (shown.version, result)
        }
    }

    /// Who wrote it, what they were asked and why it looks this way.
    private var story: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(3)) {
                Text(isProposal ? "Version \(shown.version) proposal" : "Version \(shown.version)")
                    .font(PerpetoType.title(PerpetoType.text20)).foregroundStyle(PerpetoColor.ink)
                StatusLabel(statusLabel(shown))
            }
            AuthorLine(workflow: shown)
            if let prompt = shown.authoredBy?.prompt {
                Text("“\(prompt)”")
                    .perpetoBody(PerpetoType.text14, color: PerpetoColor.inkSoft)
                    .padding(PerpetoSpacing.x(4))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(PerpetoColor.surfaceSubtle, in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
            }
            if let rationale = shown.rationale {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                    Text("Why").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
                    Text(rationale).perpetoBody().fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// What changes, whether it checks out, and the one primary action.
    private func decision(_ validation: ValidationResult) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            if let diff, !diff.isEmpty {
                Disclosure("What changes · \(diff.changeCount)", isExpanded: $showChanges) { changeList(diff) }
            }
            StatusLabel(validation.valid ? "Checks pass" : "\(Format.plural(validation.errorCount, "problem")) to fix", tone: validation.valid ? .success : .error)
            actions(validation: validation)
        }
    }

    private func statusLabel(_ w: Workflow) -> (String, StatusTone) {
        if w.status == .active { return ("Active", .ok) }
        if w.status == .paused { return ("Paused", .paused) }
        if w.version < (active?.version ?? 0) { return ("Superseded", .neutral) }
        return ("Draft", .neutral)
    }

    @ViewBuilder
    private func actions(validation: ValidationResult) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            if shown.status != .active {
                Button("Activate version \(shown.version)", action: activate)
                    .buttonStyle(.perpetoPrimary)
                    .disabled(!validation.valid)
                Text(active.map { "Runs in progress keep version \($0.version). New runs use the active version." } ?? "Nothing runs until you activate a version.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                Button("Start a run", action: startRun).buttonStyle(.perpetoPrimary)
            }
            HStack(spacing: PerpetoSpacing.x(2)) {
                Button("Ask for changes", action: askForChanges).buttonStyle(.perpetoSecondary)
                Button("Edit by hand", action: editByHand).buttonStyle(.perpetoGhost)
            }
        }
        .fullWidthButtons(compact)
        .padding(.top, PerpetoSpacing.x(1))
    }

    private func changeList(_ diff: WorkflowDiff) -> some View {
        let name = { (id: String) in shown.graph.node(id)?.label ?? diff.removedNodes.first { $0.id == id }?.label ?? id }
        var rows: [IdentifiedText] = []
        for (id, change) in diff.nodes.filter({ $0.value != .unchanged }).sorted(by: { $0.key < $1.key }) {
            rows.append(IdentifiedText(text: "\(change.title)|\(name(id))"))
        }
        for edge in shown.graph.edges where diff.edges[edge.id] == .added {
            rows.append(IdentifiedText(text: "Added|\(EdgeStyle.title(edge.kind)): \(name(edge.from.node)) to \(name(edge.to.node))"))
        }
        for edge in diff.removedEdges {
            rows.append(IdentifiedText(text: "Removed|\(EdgeStyle.title(edge.kind)): \(name(edge.from.node)) to \(name(edge.to.node))"))
        }
        return RowList(rows) { row in
            let parts = row.text.split(separator: "|", maxSplits: 1).map(String.init)
            HStack(spacing: PerpetoSpacing.x(3)) {
                Tag(parts[0]).frame(width: 76, alignment: .leading)
                Text(parts.count > 1 ? parts[1] : "").font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).lineLimit(2)
            }
        }
    }

    private var history: some View {
        RowList(versions.reversed().map { VersionRow(workflow: $0) }) { row in
            let version = row.workflow
            Button { select(version.version) } label: {
                HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(3)) {
                    Text("v\(version.version)").font(PerpetoFont.bodyMedium.monospacedDigit()).foregroundStyle(PerpetoColor.ink).frame(width: 32, alignment: .leading)
                    VStack(alignment: .leading, spacing: 2) {
                        AuthorLine(workflow: version, compact: true)
                        if let date = version.createdAt {
                            Text(Format.relative(date)).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                        }
                    }
                    Spacer()
                    StatusLabel(statusLabel(version))
                }
                .padding(.horizontal, PerpetoSpacing.x(2))
                .padding(.vertical, PerpetoSpacing.x(1))
                .background(version.version == shown.version ? PerpetoColor.surfaceSubtle : .clear, in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

struct VersionRow: Identifiable {
    var workflow: Workflow
    var id: Int { workflow.version }
}

extension WorkflowDiff {
    var changeCount: Int { nodes.values.filter { $0 != .unchanged }.count + edges.values.filter { $0 == .added }.count + removedEdges.count }
}

struct AuthorLine: View {
    var workflow: Workflow
    var compact = false

    var body: some View {
        HStack(spacing: PerpetoSpacing.x(2)) {
            Image(systemName: workflow.authoredBy?.kind == .agent ? "sparkle" : "person")
                .font(.system(size: 11)).foregroundStyle(PerpetoColor.faint)
            Text(text).font(compact ? PerpetoFont.body : PerpetoFont.caption).foregroundStyle(compact ? PerpetoColor.ink : PerpetoColor.muted)
            if !compact, let id = workflow.authoredBy?.assignmentId { Mono(id, color: PerpetoColor.muted, size: PerpetoType.text12) }
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

/// The selected step's settings, read only.
struct SelectionDetail: View {
    var graph: WorkflowGraph
    var selection: GraphSelection
    var close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
            if let id = selection.nodeId, let node = graph.node(id) {
                HStack(spacing: PerpetoSpacing.x(3)) {
                    IconTile(node.type.systemImage)
                    RowText(node.label, meta: node.type.title)
                    Spacer()
                    IconButton("xmark", label: "Close", action: close)
                }
                ConfigList(config: node.config)
            } else if let id = selection.edgeId, let edge = graph.edges.first(where: { $0.id == id }) {
                HStack(spacing: PerpetoSpacing.x(3)) {
                    IconTile("arrow.right")
                    RowText("\(graph.node(edge.from.node)?.label ?? edge.from.node) to \(graph.node(edge.to.node)?.label ?? edge.to.node)", meta: EdgeStyle.meaning(edge.kind))
                    Spacer()
                    IconButton("xmark", label: "Close", action: close)
                }
            }
        }
        .card()
    }
}

/// Read-only rendering of node config.
struct ConfigList: View {
    var config: JSONValue

    var body: some View {
        RowList((config.objectValue ?? [:]).sorted { $0.key < $1.key }.map { IdentifiedText(text: $0.key + "|" + render($0.value)) }) { row in
            let parts = row.text.split(separator: "|", maxSplits: 1).map(String.init)
            HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(4)) {
                Text(parts[0]).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).frame(width: 120, alignment: .leading)
                Text(parts.count > 1 ? parts[1] : "").font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func render(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): s
        case .number(let n): n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): b ? "Yes" : "No"
        case .null: "None"
        case .array(let a): a.map(render).joined(separator: ", ")
        case .object(let o): o.sorted { $0.key < $1.key }.map { "\($0.key): \(render($0.value))" }.joined(separator: "; ")
        }
    }
}
