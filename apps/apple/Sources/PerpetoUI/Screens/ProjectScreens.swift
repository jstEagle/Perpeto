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

/// Messages: run and project channels, threads with replies, delivery
/// receipts and an owner composer that can address any role.
struct MessagesScreen: View {
    var store: FactoryStore
    var project: Project
    var state: ProjectState
    @State private var channelId: String?
    @Environment(\.compactLayout) private var compact

    private var channel: Channel? { state.channels.first { $0.id == channelId } ?? state.channels.first }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoGap.cards) {
                ScreenHeader("Messages", subtitle: "How roles coordinate. A message never assigns work or marks anything verified.")
                if state.channels.isEmpty {
                    EmptyState("No channels yet", message: "Each run gets a channel when it starts.", systemImage: "bubble.left").card()
                } else if compact {
                    ScrollView(.horizontal, showsIndicators: false) {
                        PillPicker(state.channels.map { (value: $0.id, title: title($0), count: (state.unread[$0.id] ?? 0) > 0 ? state.unread[$0.id] : nil) },
                                   selection: Binding(get: { channel?.id ?? "" }, set: { channelId = $0 }))
                    }
                    if let channel { ChannelConversation(store: store, project: project, state: state, channel: channel, title: title(channel)).id(channel.id) }
                } else {
                    HStack(alignment: .top, spacing: PerpetoSpacing.x(6)) {
                        channelList.frame(width: 240)
                        if let channel { ChannelConversation(store: store, project: project, state: state, channel: channel, title: title(channel)).id(channel.id) }
                    }
                }
            }
            .screenPadding()
        }
    }

    private func title(_ channel: Channel) -> String {
        guard channel.id.hasPrefix("run-") else { return channel.name }
        let runId = String(channel.id.dropFirst(4))
        let run = state.runs.first { $0.id == runId }
        let name = run.flatMap { r in state.workflows.first { $0.id == r.workflowId }?.name }
        return name.map { "\($0) run" } ?? channel.name
    }

    private var channelList: some View {
        let runs = state.channels.filter { $0.id.hasPrefix("run-") }
        let others = state.channels.filter { !$0.id.hasPrefix("run-") }
        return VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            if !runs.isEmpty {
                Text("Runs").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).padding(.horizontal, PerpetoSpacing.x(3)).padding(.bottom, PerpetoSpacing.x(1))
                ForEach(runs) { row($0) }
            }
            if !others.isEmpty {
                Text("Project").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    .padding(.horizontal, PerpetoSpacing.x(3)).padding(.top, PerpetoSpacing.x(runs.isEmpty ? 0 : 5)).padding(.bottom, PerpetoSpacing.x(1))
                ForEach(others) { row($0) }
            }
        }
    }

    private func row(_ c: Channel) -> some View {
        let unread = state.unread[c.id] ?? 0
        let live = state.runs.contains { "run-" + $0.id == c.id && $0.status == .running }
        return NavItem(title: title(c), systemImage: c.id.hasPrefix("run-") ? "play.circle" : "number", selected: c.id == channel?.id,
                       trailing: unread > 0 ? .count(unread) : (live ? .live : nil)) { channelId = c.id }
    }
}

/// One channel: threads oldest first, replies indented under their root,
/// and the composer at the bottom.
struct ChannelConversation: View {
    var store: FactoryStore
    var project: Project
    var state: ProjectState
    var channel: Channel
    var title: String

    @State private var draft = ""
    @State private var replyingTo: Message?
    @State private var recipient: MessageRecipient = .everyone
    @FocusState private var composing: Bool
    @Environment(\.compactLayout) private var compact

    private var messages: [Message] { state.messages[channel.id] ?? [] }

    /// Roots in time order, each with its replies.
    private var threads: [(root: Message, replies: [Message])] {
        let byThread = Dictionary(grouping: messages, by: \.threadId)
        return messages.filter { $0.isRoot || byThread[$0.threadId]?.contains(where: \.isRoot) == false && $0.id == byThread[$0.threadId]?.first?.id }
            .map { root in (root, (byThread[root.threadId] ?? []).filter { $0.id != root.id }.sorted { $0.createdAt < $1.createdAt }) }
    }

    /// The newest messages for the owner, as many as the unread count.
    private var unreadIds: Set<String> {
        let count = state.unread[channel.id] ?? 0
        guard count > 0 else { return [] }
        let forOwner = messages.filter { $0.senderRoleId != "owner" && ($0.recipientRoleId == nil || $0.recipientRoleId == "owner") }
        return Set(forOwner.suffix(count).map(\.id))
    }

    /// The graph's agent roles and anyone already talking here.
    private var roles: [String] {
        let runId = channel.id.hasPrefix("run-") ? String(channel.id.dropFirst(4)) : nil
        let run = state.runs.first { $0.id == runId } ?? state.runs.first
        let graph = run.flatMap { r in state.version(r.workflowVersion, of: r.workflowId)?.graph ?? state.workflows.first { $0.id == r.workflowId }?.graph }
        var ids = (graph?.nodes ?? []).filter(\.type.isAgentRole).map { $0.config["role"]?.stringValue ?? $0.id }
        for m in messages { ids += [m.senderRoleId, m.recipientRoleId].compactMap { $0 } }
        var seen = Set<String>()
        return ids.filter { $0 != "owner" && seen.insert($0).inserted }
    }

    private func roleName(_ role: String) -> String {
        if role == "owner" { return "You" }
        let graphs = state.workflows.map(\.graph)
        return graphs.lazy.compactMap { $0.nodes.first { ($0.config["role"]?.stringValue ?? $0.id) == role }?.label }.first ?? role
    }

    var body: some View {
        let unread = unreadIds
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
            SectionTitle(title, detail: Format.plural(threads.count, "thread") + (unread.isEmpty ? "" : " · \(unread.count) unread"))
            if messages.isEmpty {
                Text("No messages in this channel yet.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted).padding(.vertical, PerpetoSpacing.x(4))
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(threads.enumerated()), id: \.element.root.id) { index, thread in
                        if index > 0 { Rule() }
                        VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                            MessageView(message: thread.root, unread: unread.contains(thread.root.id), roleName: roleName,
                                        reply: { startReply(thread.root) }, acknowledge: { Task { await store.acknowledge(thread.root) } })
                            if !thread.replies.isEmpty {
                                VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
                                    ForEach(thread.replies) { reply in
                                        MessageView(message: reply, unread: unread.contains(reply.id), roleName: roleName,
                                                    reply: { startReply(reply) }, acknowledge: { Task { await store.acknowledge(reply) } })
                                    }
                                }
                                .padding(.leading, PerpetoSpacing.x(5))
                                .overlay(alignment: .leading) { Rectangle().fill(PerpetoColor.border).frame(width: 2).padding(.vertical, 2) }
                                .padding(.leading, PerpetoSpacing.x(compact ? 0 : 14))
                            }
                        }
                        .padding(.vertical, PerpetoSpacing.x(4))
                    }
                }
            }
            composer.padding(.top, PerpetoSpacing.x(3))
        }
        .card()
        .task {
            // Opening a channel reads it: move the owner's cursor forward.
            try? await Task.sleep(for: .seconds(1.5))
            await store.markRead(projectId: project.id, channelId: channel.id)
        }
    }

    private func startReply(_ message: Message) {
        replyingTo = message
        recipient = .parentSender
        composing = true
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            if let parent = replyingTo {
                HStack(spacing: PerpetoSpacing.x(2)) {
                    Image(systemName: "arrowshape.turn.up.left").font(.system(size: 11)).foregroundStyle(PerpetoColor.faint)
                    Text("Replying to \(roleName(parent.senderRoleId)): \(parent.body)").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).lineLimit(1)
                    Spacer()
                    Button { replyingTo = nil; recipient = .everyone } label: {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(PerpetoColor.muted).frame(width: 20, height: 20)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel reply")
                }
            }
            HStack(alignment: .bottom, spacing: PerpetoSpacing.x(2)) {
                Menu {
                    if replyingTo != nil { Button("Whoever wrote it") { recipient = .parentSender } }
                    Button("Everyone in the channel") { recipient = .everyone }
                    Divider()
                    ForEach(roles, id: \.self) { role in Button(roleName(role)) { recipient = .role(role) } }
                } label: {
                    Label(recipientTitle, systemImage: "chevron.up.chevron.down").labelStyle(TrailingIconLabelStyle())
                }
                .menuStyle(.button)
                .buttonStyle(.perpetoSecondary)
                .controlSize(.small)
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityLabel("Recipient: \(recipientTitle)")
                TextField(replyingTo == nil ? "Message as owner" : "Reply in thread", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .perpetoField()
                    .focused($composing)
                    .onSubmit(send)
                Button("Send", action: send)
                    .buttonStyle(.perpetoPrimary)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private var recipientTitle: String {
        switch recipient {
        case .everyone: "To everyone"
        case .role(let role): "To \(roleName(role))"
        case .parentSender: "To \(replyingTo.map { roleName($0.senderRoleId == "owner" ? ($0.recipientRoleId ?? "owner") : $0.senderRoleId) } ?? "sender")"
        }
    }

    private func send() {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        draft = ""
        let parent = replyingTo?.id
        let to = recipient
        replyingTo = nil
        recipient = .everyone
        Task { await store.send(projectId: project.id, channelId: channel.id, body: body, to: to, parentId: parent) }
    }
}

/// One message: who to whom, when, the text, and how far delivery got.
struct MessageView: View {
    var message: Message
    var unread: Bool
    var roleName: (String) -> String
    var reply: () -> Void
    var acknowledge: () -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(2)) {
            HStack(alignment: .firstTextBaseline, spacing: PerpetoSpacing.x(2)) {
                if unread {
                    Circle().fill(PerpetoColor.ink).frame(width: 6, height: 6).accessibilityLabel("Unread")
                }
                Text(roleName(message.senderRoleId)).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                Text("to \(message.recipientRoleId.map(roleName) ?? "everyone")").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                Text(message.createdAt.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)))
                    .font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.muted)
                if message.unplanned { StatusLabel("Unplanned", tone: .warning).help("No messages edge in the workflow connects these roles.") }
                Spacer(minLength: 0)
            }
            Text(message.body).perpetoBody().textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: PerpetoSpacing.x(4)) {
                if let receipt = message.receipt { ReceiptLabel(receipt: receipt, toOwner: message.recipientRoleId == "owner") }
                Button("Reply", action: reply).buttonStyle(.plain).font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.inkSoft)
                if message.recipientRoleId == "owner", message.receipt?.state != .acked {
                    Button("Acknowledge", action: acknowledge).buttonStyle(.plain).font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink)
                        .help("Tell the sender you have seen this")
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Receipt state, quietly: an icon and a few words.
struct ReceiptLabel: View {
    var receipt: Receipt
    var toOwner = false

    var body: some View {
        HStack(spacing: PerpetoSpacing.x(1.5)) {
            Image(systemName: symbol).font(.system(size: 11, weight: .medium)).foregroundStyle(receipt.state == .stored ? PerpetoColor.faint : PerpetoColor.inkSoft)
            Text(text).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
        }
        .help(help)
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch receipt.state {
        case .stored, .unknown: "clock"
        case .delivered: "checkmark"
        case .acked: "checkmark.circle"
        }
    }

    private var text: String {
        switch receipt.state {
        case .stored, .unknown: return toOwner ? "Waiting for you" : "Waiting for the role"
        case .acked: return "Acknowledged" + (receipt.ackedAt.map { " " + Format.relative($0) } ?? "")
        case .delivered:
            switch receipt.deliveredVia {
            case .prompt: return "Delivered in the first prompt"
            case .steer: return "Delivered into the running turn"
            case .read: return "Read"
            default: return "Delivered"
            }
        }
    }

    private var help: String {
        "Delivery shows the message reached the agent. It does not prove the model understood or acted on it."
    }
}
