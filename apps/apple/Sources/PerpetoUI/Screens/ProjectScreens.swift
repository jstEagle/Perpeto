import PerpetoKit
import SwiftUI

// MARK: Work

struct WorkScreen: View {
    var store: FactoryStore
    var project: Project
    var state: ProjectState
    @State private var selection: WorkItem.ID?
    @State private var filter: WorkItem.Status?
    @Environment(\.compactLayout) private var compact

    private var items: [WorkItem] {
        state.workItems.filter { filter == nil || $0.status == filter }
    }

    private func nodeLabel(_ item: WorkItem) -> String {
        guard let run = state.runs.first(where: { $0.id == item.runId }) else { return item.nodeId }
        let graph = state.version(run.workflowVersion, of: run.workflowId)?.graph ?? state.workflows.first { $0.id == run.workflowId }?.graph
        return graph?.node(item.nodeId)?.label ?? item.nodeId
    }

    private var selected: WorkItem? { state.workItems.first { $0.id == selection } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Work", subtitle: "Work items across runs and the agents assigned to them.")
                if state.workItems.isEmpty {
                    EmptyState("No work yet", message: "Work items appear when a run's planner splits its input.", systemImage: "checklist").card()
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        PillPicker([(value: WorkItem.Status?.none, title: "All", count: state.workItems.count)]
                                   + [WorkItem.Status.active, .queued, .blocked, .done, .failed].compactMap { status in
                                       let n = state.workItems.filter { $0.status == status }.count
                                       return n > 0 ? (value: Optional(status), title: status == .blocked ? "Waiting" : status.label.0, count: n) : nil
                                   }, selection: $filter)
                    }
                    AdaptiveColumns(sideWidth: 400) {
                        RowList(items) { item in
                            Button { selection = item.id } label: { row(item) }.buttonStyle(.plain)
                        }
                        .card()
                    } side: {
                        if !compact {
                            if let item = selected {
                                WorkItemDetail(store: store, project: project, item: item, assignments: state.assignments.filter { $0.workItemId == item.id }, nodeLabel: nodeLabel(item)) { selection = nil }
                            } else {
                                Text("Select a work item to see its agents, branch and pull request.")
                                    .font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                                    .card()
                            }
                        }
                    }
                }
            }
            .screenPadding()
        }
        .sheet(isPresented: Binding(get: { compact && selected != nil }, set: { if !$0 { selection = nil } })) {
            if let item = selected {
                ScrollView {
                    WorkItemDetail(store: store, project: project, item: item, assignments: state.assignments.filter { $0.workItemId == item.id }, nodeLabel: nodeLabel(item)) { selection = nil }
                        .padding(PerpetoSpacing.x(4))
                }
                .background(PerpetoColor.canvas)
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(PerpetoRadius.sheet)
            }
        }
    }

    private func row(_ item: WorkItem) -> some View {
        HStack(spacing: PerpetoSpacing.x(3)) {
            RowText(item.title, meta: [nodeLabel(item), item.iteration > 1 ? "round \(item.iteration)" : nil, item.prUrl.map(Format.prNumber)].compactMap { $0 }.joined(separator: " · "))
            Spacer(minLength: PerpetoSpacing.x(2))
            StatusLabel(item.statusLabel)
        }
        .padding(.horizontal, PerpetoSpacing.x(2))
        .padding(.vertical, PerpetoSpacing.x(1))
        .background(selection == item.id ? PerpetoColor.surfaceSubtle : .clear, in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
        .padding(.horizontal, -PerpetoSpacing.x(2))
        .contentShape(Rectangle())
    }
}

struct WorkItemDetail: View {
    var store: FactoryStore
    var project: Project
    var item: WorkItem
    var assignments: [Assignment]
    var nodeLabel: String
    var close: () -> Void
    @State private var showDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                    Text(item.title).font(PerpetoType.title(PerpetoType.text20)).foregroundStyle(PerpetoColor.ink).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: PerpetoSpacing.x(3)) {
                        StatusLabel(item.statusLabel)
                        Text("at \(nodeLabel)" + (item.iteration > 1 ? " · round \(item.iteration)" : "")).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    }
                }
                Spacer()
                IconButton("xmark", label: "Close", action: close)
            }
            if item.status == .blocked {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                    Text(item.decisionId != nil ? "A person decides before this work continues." : "Waiting on another item.")
                        .font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink)
                    if item.decisionId != nil {
                        HStack(spacing: PerpetoSpacing.x(2)) {
                            Button("Approve") { Task { await store.decide(projectId: project.id, item: item, .pass) } }.buttonStyle(.perpetoPrimary)
                            Button("Return for changes") { Task { await store.decide(projectId: project.id, item: item, .fail) } }.buttonStyle(.perpetoSecondary)
                        }
                    }
                }
            }
            if !item.body.isEmpty {
                Text(item.body).perpetoBody().fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text("Agents").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
                if assignments.isEmpty {
                    Text("No agent has been assigned yet.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.top, PerpetoSpacing.x(3))
                } else {
                    RowList(assignments) { a in
                        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                            HStack {
                                RowText(a.role.capitalizedFirst, meta: "\(Format.model(a.harness.model))" + (store.machine(a.machineId).map { " on \($0.name)" } ?? "") + (a.attempt > 1 ? " · attempt \(a.attempt)" : ""))
                                Spacer()
                                StatusLabel(a.status.label)
                            }
                            if let result = a.result, !result.summary.isEmpty {
                                Text(result.summary).font(PerpetoFont.body).foregroundStyle(result.outcome == .failure ? PerpetoColor.error : PerpetoColor.inkSoft)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            }
            Disclosure("Branch and pull request", isExpanded: $showDetails) {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                    detailRow("Branch", item.branch)
                    detailRow("Pull request", item.prUrl)
                    detailRow("Head", item.headSha)
                    detailRow("ID", item.id)
                }
            }
        }
        .card()
    }

    @ViewBuilder
    private func detailRow(_ label: String, _ value: String?) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).frame(width: 96, alignment: .leading)
            Mono(value ?? "None", color: value == nil ? PerpetoColor.muted : PerpetoColor.ink)
        }
    }
}

// MARK: Merge queue

struct MergeQueueScreen: View {
    var store: FactoryStore
    var project: Project
    var state: ProjectState

    var body: some View {
        let queue = state.mergeQueue
        let open = queue.filter { $0.status == .queued || $0.status == .testing || $0.status == .merging }
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Merge queue", subtitle: "Pull requests merge into \(project.repo.defaultBranch) one at a time, after checks pass at their exact head commit.")
                if queue.isEmpty {
                    EmptyState("The queue is empty", message: "Pull requests join the queue when they pass review and CI.", systemImage: "arrow.triangle.branch").card()
                } else {
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) {
                        FigureStrip([
                            Figure("In the queue", value: "\(open.count)"),
                            Figure("Merged", value: "\(queue.filter { $0.status == .merged }.count)"),
                            Figure("Rejected", value: "\(queue.filter { $0.status == .rejected }.count)"),
                        ])
                    }
                    .card()
                    RowList(queue) { entry in
                        let item = state.workItems.first { $0.prUrl == entry.prUrl }
                        HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                            Text(open.firstIndex(of: entry).map { "\($0 + 1)" } ?? "")
                                .font(PerpetoFont.bodyMedium.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                                .frame(width: 20, alignment: .leading)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item?.title ?? Format.prNumber(entry.prUrl)).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                                HStack(spacing: 5) {
                                    Text(Format.prNumber(entry.prUrl)).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                                    Text("·").foregroundStyle(PerpetoColor.muted)
                                    Mono(Format.shortSha(entry.headSha))
                                    Text("into").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                                    Mono(entry.baseBranch)
                                }
                                if let reason = entry.reason, !reason.isEmpty {
                                    Text(reason).font(PerpetoFont.caption).foregroundStyle(entry.status == .rejected ? PerpetoColor.inkSoft : PerpetoColor.muted)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer(minLength: PerpetoSpacing.x(2))
                            StatusLabel(entry.status.label)
                        }
                    }
                    .card()
                }
            }
            .screenPadding()
        }
    }
}

// MARK: Messages

struct MessagesScreen: View {
    var store: FactoryStore
    var project: Project
    var state: ProjectState
    @State private var channelId: String?
    @State private var draft = ""
    @Environment(\.compactLayout) private var compact

    var body: some View {
        let channel = channelId ?? state.channels.first?.id
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Messages", subtitle: "How roles coordinate. Messages do not assign work or mark anything verified.")
                if state.channels.isEmpty {
                    EmptyState("No channels yet", message: "Each run gets a channel when it starts.", systemImage: "bubble.left").card()
                } else if compact {
                    ScrollView(.horizontal, showsIndicators: false) {
                        PillPicker(state.channels.map { ($0.id, $0.name) }, selection: Binding(get: { channel ?? "" }, set: { channelId = $0 }))
                    }
                    if let channel { thread(channel) }
                } else {
                    HStack(alignment: .top, spacing: PerpetoSpacing.x(6)) {
                        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                            ForEach(state.channels) { c in
                                NavItem(title: c.name, systemImage: c.id.hasPrefix("run-") ? "play.circle" : "number", selected: c.id == channel,
                                        trailing: (state.messages[c.id]?.count).flatMap { $0 > 0 ? .count($0) : nil }) { channelId = c.id }
                            }
                        }
                        .frame(width: 240)
                        if let channel { thread(channel) }
                    }
                }
            }
            .screenPadding()
        }
    }

    private func thread(_ channel: String) -> some View {
        let messages = state.messages[channel] ?? []
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
            if messages.isEmpty {
                Text("No messages in this channel yet.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
            } else {
                RowList(messages) { MessageRow(message: $0) }
            }
            HStack(spacing: PerpetoSpacing.x(2)) {
                TextField("Message as owner", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .perpetoField()
                    .onSubmit(send)
                Button("Send", action: send)
                    .buttonStyle(.perpetoPrimary)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.top, PerpetoSpacing.x(2))
        }
        .card()
    }

    private func send() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, let channel = channelId ?? state.channels.first?.id else { return }
        draft = ""
        Task { await store.send(projectId: project.id, channelId: channel, body: body) }
    }
}

struct MessageRow: View {
    var message: Message

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(5)) {
            Text(message.createdAt.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)))
                .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                .frame(width: 40, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(message.body).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Text(message.senderRoleId.capitalizedFirst + (message.recipientRoleId.map { " to \($0)" } ?? " to everyone"))
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
            Spacer(minLength: 0)
        }
    }
}
