import PerpetoKit
import SwiftUI

struct WorkScreen: View {
    var store: FactoryStore
    var project: Project
    var state: ProjectState
    @State private var selection: WorkItem.ID?
    @State private var filter: WorkItem.Status?

    private var items: [WorkItem] {
        state.workItems.filter { filter == nil || $0.status == filter }
    }

    private func nodeLabel(_ item: WorkItem) -> String {
        guard let run = state.runs.first(where: { $0.id == item.runId }) else { return item.nodeId }
        let graph = state.version(run.workflowVersion, of: run.workflowId)?.graph ?? state.workflows.first { $0.id == run.workflowId }?.graph
        return graph?.node(item.nodeId)?.label ?? item.nodeId
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            ScreenHeader("Work", subtitle: "Work items across runs and the agents assigned to them.") {
                Picker("Status", selection: $filter) {
                    Text("All").tag(WorkItem.Status?.none)
                    ForEach([WorkItem.Status.active, .queued, .blocked, .done, .failed], id: \.self) { status in
                        Text("\(status.label.0) \(state.workItems.filter { $0.status == status }.count)").tag(Optional(status))
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 420)
            }
            if state.workItems.isEmpty {
                EmptyState("No work yet", message: "Work items appear when a run's planner splits its input.").panel()
            } else {
                HStack(alignment: .top, spacing: PerpetoSpacing.x(4)) {
                    TablePanel {
                        Table(items, selection: $selection) {
                            TableColumn("Work item") { item in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.title).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                                    Mono(item.branch ?? item.id)
                                }
                                .padding(.vertical, PerpetoSpacing.x(1))
                            }
                            .width(min: 260, ideal: 340)
                            TableColumn("Status") { item in StatusLabel(item.status.label) }.width(80)
                            TableColumn("At") { item in Text(nodeLabel(item)).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink) }.width(min: 90, ideal: 110)
                            TableColumn("Iteration") { item in
                                Text("\(item.iteration)").font(PerpetoFont.body.monospacedDigit())
                                    .foregroundStyle(item.iteration >= 3 ? PerpetoColor.warning : PerpetoColor.ink)
                            }
                            .width(64)
                            TableColumn("PR") { item in Mono(Format.prNumber(item.prUrl), color: PerpetoColor.ink) }.width(56)
                            TableColumn("Head") { item in Mono(Format.shortSha(item.headSha)) }.width(70)
                        }
                    }
                    if let item = state.workItems.first(where: { $0.id == selection }) {
                        WorkItemDetail(store: store, project: project, item: item, assignments: state.assignments.filter { $0.workItemId == item.id }, nodeLabel: nodeLabel(item))
                            .frame(width: 340)
                    }
                }
            }
        }
        .padding(PerpetoSpacing.x(6))
    }
}

struct WorkItemDetail: View {
    var store: FactoryStore
    var project: Project
    var item: WorkItem
    var assignments: [Assignment]
    var nodeLabel: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
                    Text(item.title).font(PerpetoFont.title(PerpetoType.size16)).foregroundStyle(PerpetoColor.ink)
                    HStack(spacing: PerpetoSpacing.x(2)) {
                        StatusLabel(item.status.label)
                        Text("at \(nodeLabel) · iteration \(item.iteration)").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    }
                    Text(item.body).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).fixedSize(horizontal: false, vertical: true)
                }
                Rule()
                VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
                    detailRow("Branch", item.branch)
                    detailRow("Pull request", item.prUrl)
                    detailRow("Head", item.headSha)
                    detailRow("ID", item.id)
                }
                Rule()
                Text("Assignments").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                if assignments.isEmpty {
                    Text("No agent has been assigned yet.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                }
                ForEach(assignments) { a in
                    VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
                        HStack {
                            Text(a.role).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                            Spacer()
                            StatusLabel(a.status.label)
                        }
                        Mono("\(Format.provider(a.harness.provider)) · \(a.harness.model) · attempt \(a.attempt)")
                        if let machine = store.machine(a.machineId) {
                            Text("On \(machine.name)").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                        }
                        Text("Policy: up to \(a.policy.maxSubagents) subagents" + (a.policy.allowedSubagentProviders.isEmpty ? "" : " (\(a.policy.allowedSubagentProviders.map(Format.provider).joined(separator: ", ")))") + (a.policy.canMessage.isEmpty ? "" : "; may message \(a.policy.canMessage.joined(separator: ", "))"))
                            .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                        if let result = a.result {
                            Text(result.summary).font(PerpetoFont.body).foregroundStyle(result.outcome == .success ? PerpetoColor.ink : PerpetoColor.error)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(PerpetoSpacing.x(3))
                    .background(PerpetoColor.canvas, in: RoundedRectangle(cornerRadius: PerpetoRadius.control))
                }
                if item.status == .blocked {
                    HStack {
                        Button("Approve") { Task { await store.decide(projectId: project.id, workItemId: item.id, .pass) } }.buttonStyle(.perpetoPrimary)
                        Button("Return for changes") { Task { await store.decide(projectId: project.id, workItemId: item.id, .fail) } }.buttonStyle(.perpetoSecondary)
                    }
                }
            }
            .padding(PerpetoSpacing.x(4))
        }
        .background(PerpetoColor.surface, in: RoundedRectangle(cornerRadius: PerpetoRadius.panel))
        .overlay(RoundedRectangle(cornerRadius: PerpetoRadius.panel).strokeBorder(PerpetoColor.border))
    }

    @ViewBuilder
    private func detailRow(_ label: String, _ value: String?) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).frame(width: 84, alignment: .leading)
            Mono(value ?? "—", color: PerpetoColor.ink)
        }
    }
}

struct MergeQueueScreen: View {
    var store: FactoryStore
    var project: Project
    var state: ProjectState

    var body: some View {
        let queue = state.mergeQueue
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            ScreenHeader("Merge queue", subtitle: "Pull requests merge into \(project.repo.defaultBranch) one at a time, after CI passes at their exact head commit.")
            if queue.isEmpty {
                EmptyState("The queue is empty", message: "PRs join the queue when they pass review and CI.").panel()
            } else {
                TablePanel {
                    Table(queue) {
                        TableColumn("Position") { entry in
                            let open = queue.filter { $0.status == .queued || $0.status == .testing || $0.status == .merging }
                            Text(open.firstIndex(of: entry).map { "\($0 + 1)" } ?? "—").font(PerpetoFont.body.monospacedDigit()).foregroundStyle(PerpetoColor.ink)
                        }
                        .width(60)
                        TableColumn("Pull request") { entry in
                            let item = state.workItems.first { $0.prUrl == entry.prUrl }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item?.title ?? Format.prNumber(entry.prUrl)).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink).lineLimit(1)
                                Mono("\(Format.prNumber(entry.prUrl)) · \(entry.id)")
                            }
                            .padding(.vertical, PerpetoSpacing.x(1))
                        }
                        .width(min: 260, ideal: 340)
                        TableColumn("Status") { entry in StatusLabel(entry.status.label) }.width(90)
                        TableColumn("Head") { entry in Mono(Format.shortSha(entry.headSha)) }.width(80)
                        TableColumn("Base") { entry in Mono(entry.baseBranch) }.width(70)
                        TableColumn("CI job") { entry in
                            if let job = store.factory.jobs.first(where: { $0.id == entry.jobId }) {
                                HStack(spacing: PerpetoSpacing.x(2)) { Mono(job.id); StatusLabel(job.status.label) }
                            } else {
                                Mono(entry.jobId ?? "—")
                            }
                        }
                        TableColumn("Reason") { entry in
                            Text(entry.reason ?? "").font(PerpetoFont.body).foregroundStyle(entry.status == .rejected ? PerpetoColor.error : PerpetoColor.muted).lineLimit(2)
                        }
                    }
                }
            }
        }
        .padding(PerpetoSpacing.x(6))
    }
}

struct MessagesScreen: View {
    var store: FactoryStore
    var project: Project
    var state: ProjectState
    @State private var channelId: String?
    @State private var draft = ""

    var body: some View {
        let channel = channelId ?? state.channels.first?.id
        HStack(spacing: 0) {
            List(selection: $channelId) {
                Section("Channels") {
                    ForEach(state.channels) { c in
                        SidebarLabel(title: c.name, systemImage: c.id.hasPrefix("run-") ? "play.square" : "number")
                            .tag(Optional(c.id))
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .frame(width: 220)
            .background(PerpetoColor.canvas)
            .onAppear { if channelId == nil { channelId = state.channels.first?.id } }
            Rule(vertical: true)
            if let channel {
                VStack(spacing: 0) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(state.messages[channel] ?? []) { message in
                                    MessageRow(message: message)
                                    Rule()
                                }
                            }
                            .padding(.horizontal, PerpetoSpacing.x(6))
                        }
                        .onAppear { proxy.scrollTo(state.messages[channel]?.last?.id, anchor: .bottom) }
                    }
                    Rule()
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
                    .padding(PerpetoSpacing.x(4))
                    .background(PerpetoColor.surface)
                    Text("Messages coordinate roles. They do not assign work or mark anything verified.")
                        .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                        .padding(.bottom, PerpetoSpacing.x(2))
                        .frame(maxWidth: .infinity)
                        .background(PerpetoColor.surface)
                }
                .background(PerpetoColor.surface)
            } else {
                EmptyState("No channels yet", message: "Each run gets a channel when it starts.")
            }
        }
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
        HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(4)) {
            Text(Format.clock(message.createdAt)).font(PerpetoFont.mono()).foregroundStyle(PerpetoColor.muted)
                .frame(width: 64, alignment: .leading)
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                HStack(spacing: PerpetoSpacing.x(1.5)) {
                    Text(message.senderRoleId).font(PerpetoFont.mono()).foregroundStyle(PerpetoColor.ink)
                    if let to = message.recipientRoleId {
                        Image(systemName: "arrow.right").font(.system(size: 9)).foregroundStyle(PerpetoColor.muted)
                        Text(to).font(PerpetoFont.mono()).foregroundStyle(PerpetoColor.ink)
                    }
                }
                Text(message.body).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, PerpetoSpacing.x(3))
    }
}
