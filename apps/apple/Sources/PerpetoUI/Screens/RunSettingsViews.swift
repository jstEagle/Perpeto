import PerpetoKit
import SwiftUI

extension EnvironmentValues {
    /// iPhone shows run settings and workflows read only.
    @Entry var readOnlySettings = false
}

// MARK: Budget use

/// Today's budget use as one calm line per limit with a meter.
struct BudgetLine: View {
    var run: Run

    var body: some View {
        if let budget = run.settings.budget, !budget.isEmpty {
            let usage = run.budgetUsage
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                if let max = budget.maxTokensPerDay {
                    row("Tokens today", used: usage?.tokens ?? 0, of: max, text: "\(Format.tokens(usage?.tokens ?? 0)) of \(Format.tokens(max))")
                }
                if let max = budget.maxItemsPerDay {
                    row("Items today", used: usage?.items ?? 0, of: max, text: "\(usage?.items ?? 0) of \(max)")
                }
                if let max = budget.maxActiveItems {
                    let active = run.intake?.reason?.limit == .maxActiveItems ? run.intake?.reason?.used : nil
                    row("Active items", used: active ?? 0, of: max, text: active.map { "\($0) of \(max)" } ?? "Up to \(max)", meter: active != nil)
                }
            }
        }
    }

    private func row(_ title: String, used: Int, of max: Int, text: String, meter: Bool = true) -> some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
            HStack {
                Text(title).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                Spacer()
                Text(text).font(PerpetoFont.caption.monospacedDigit()).foregroundStyle(PerpetoColor.inkSoft)
            }
            if meter { Meter(Double(used) / Double(Swift.max(max, 1))) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// What a budget hold means and when intake comes back.
enum BudgetHold {
    static func title(_ run: Run) -> String {
        switch run.intake?.reason?.limit {
        case .maxTokensPerDay: "Daily token budget reached"
        case .maxItemsPerDay: "Daily item budget reached"
        case .maxActiveItems: "Active item limit reached"
        default: "Intake paused by budget"
        }
    }

    static func detail(_ run: Run, now: Date = Date()) -> String {
        guard let reason = run.intake?.reason else { return "New work waits; work already started may finish." }
        let used = reason.limit == .maxTokensPerDay ? Format.tokens(reason.used) : "\(reason.used)"
        let maximum = reason.limit == .maxTokensPerDay ? Format.tokens(reason.maximum) : "\(reason.maximum)"
        let resume: String
        switch reason.limit {
        case .maxActiveItems: resume = "Intake resumes when fewer than \(reason.maximum) items are active."
        default:
            let midnight = Calendar.utc.startOfDay(for: now).addingTimeInterval(86400)
            resume = "Intake resumes at 00:00 UTC (\(midnight.formatted(date: .omitted, time: .shortened)) your time, in \(Format.duration(midnight.timeIntervalSince(now))))."
        }
        return "\(used) of \(maximum) used. New work waits; work already started may finish. \(resume)"
    }
}

/// The paused-by-budget state, shown where a run is summarised.
struct BudgetHoldNote: View {
    var run: Run
    var body: some View {
        HStack(alignment: .top, spacing: PerpetoSpacing.x(3)) {
            StatusIcon(.paused, size: 18).padding(.top, 1)
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1)) {
                Text(BudgetHold.title(run)).font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                Text(BudgetHold.detail(run)).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: Settings summary

/// "Keeps running · takes work from goals · weekdays at 09:00 UTC".
struct RunSettingsSummary: View {
    var settings: RunSettings

    var body: some View {
        Text(Self.text(settings)).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
    }

    static func text(_ s: RunSettings) -> String {
        var parts = [s.keepOpen ? "Keeps running" : "Stops when its work is done"]
        switch s.source {
        case .goals: parts.append("takes work from goals")
        case .schedule: parts.append(s.schedule.map { "improves on a schedule, " + ScheduleRule(cron: $0).summary } ?? "improves on a schedule")
        case .manual: parts.append("takes work you add")
        default: break
        }
        if let b = s.budget, !b.isEmpty {
            let limits = [b.maxTokensPerDay.map { "\(Format.tokens($0)) tokens" }, b.maxItemsPerDay.map { "\($0) items" }].compactMap { $0 }
            if !limits.isEmpty { parts.append(limits.joined(separator: " and ") + " a day") }
            if let active = b.maxActiveItems { parts.append("up to \(active) at once") }
        }
        return parts.joined(separator: " · ")
    }
}

// MARK: Schedule

// MARK: Settings sheet

/// Keep running, where work comes from, and how much a run may take each day.
struct RunSettingsSheet: View {
    var title: String
    var confirm: String
    @State var settings: RunSettings
    var save: (RunSettings) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var rule = ScheduleRule()
    @State private var tokens = ""
    @State private var items = ""
    @State private var active = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(6)) {
                Text(title).font(PerpetoType.title(PerpetoType.text24)).foregroundStyle(PerpetoColor.ink)

                Toggle(isOn: $settings.keepOpen) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Keep running").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                        Text("Take in new work after the first batch is done.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    }
                }
                .toggleStyle(.switch)
                .tint(PerpetoColor.ink)

                VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                    Text("Where new work comes from").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                    PillPicker([(RunSettings.Source.goals, "Goals"), (.schedule, "Schedule"), (.manual, "Manual")],
                               selection: Binding(get: { settings.source ?? .goals }, set: { settings.source = $0 }))
                    Text(sourceHelp).font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                    if settings.source == .schedule { scheduleEditor }
                }

                VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
                    Text("Daily budget").font(PerpetoFont.bodyMedium).foregroundStyle(PerpetoColor.ink)
                    Text("Limits pause new work, not work already started. Leave a field empty for no limit. Days are UTC.")
                        .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted).fixedSize(horizontal: false, vertical: true)
                    limitField("Tokens per day", text: $tokens, example: "2M")
                    limitField("Items per day", text: $items, example: "20")
                    limitField("Active items at once", text: $active, example: "5")
                }

                HStack {
                    Spacer()
                    Button("Cancel") { dismiss() }.buttonStyle(.perpetoGhost).keyboardShortcut(.cancelAction)
                    Button(confirm) {
                        var result = settings
                        if result.source == .schedule { result.schedule = rule.cron } else { result.schedule = nil }
                        let budget = RunBudget(maxTokensPerDay: Self.parse(tokens), maxItemsPerDay: Self.parse(items), maxActiveItems: Self.parse(active))
                        result.budget = budget.isEmpty ? nil : budget
                        save(result)
                        dismiss()
                    }
                    .buttonStyle(.perpetoPrimary)
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(PerpetoSpacing.x(8))
        }
        .frame(minWidth: 420, idealWidth: 520, minHeight: 520)
        .background(PerpetoColor.surface)
        .presentationCornerRadius(PerpetoRadius.sheet)
        .onAppear {
            if settings.source == nil { settings.source = .goals }
            if let cron = settings.schedule { rule = ScheduleRule(cron: cron) }
            tokens = settings.budget?.maxTokensPerDay.map { Format.tokens($0) } ?? ""
            items = settings.budget?.maxItemsPerDay.map(String.init) ?? ""
            active = settings.budget?.maxActiveItems.map(String.init) ?? ""
        }
    }

    private var sourceHelp: String {
        switch settings.source ?? .goals {
        case .goals: "The planner takes the next unfinished goal when there is room."
        case .schedule: "An improvement pass starts on the schedule below."
        default: "Only work you add starts."
        }
    }

    private var scheduleEditor: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(3)) {
            if let custom = rule.custom {
                HStack {
                    Text("Custom schedule").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    Mono(custom, color: PerpetoColor.ink)
                    Button("Replace") { rule = ScheduleRule() }.buttonStyle(.perpetoGhost).controlSize(.small)
                }
            } else {
                PillPicker(ScheduleRule.Frequency.allCases.map { ($0, $0.title) }, selection: $rule.frequency)
                HStack(spacing: PerpetoSpacing.x(3)) {
                    if rule.frequency == .weekly {
                        Picker("Day", selection: $rule.weekday) {
                            ForEach(0..<7) { Text(ScheduleRule.dayNames[$0]).tag($0) }
                        }
                        .labelsHidden()
                        .fixedSize()
                    }
                    if rule.frequency == .hourly {
                        Picker("Minute", selection: $rule.minute) {
                            ForEach([0, 15, 30, 45], id: \.self) { Text(String(format: "at :%02d", $0)).tag($0) }
                        }
                        .labelsHidden()
                        .fixedSize()
                    } else {
                        DatePicker("Time", selection: timeBinding, displayedComponents: .hourAndMinute)
                            .labelsHidden()
                            .environment(\.timeZone, TimeZone(identifier: "UTC")!)
                        Text("UTC").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    }
                }
            }
            Text("Runs \(rule.summary).").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.inkSoft)
        }
        .padding(PerpetoSpacing.x(4))
        .background(PerpetoColor.surfaceSubtle, in: RoundedRectangle(cornerRadius: PerpetoRadius.control, style: .continuous))
    }

    private var timeBinding: Binding<Date> {
        Binding(
            get: { Calendar.utc.date(bySettingHour: rule.hour, minute: rule.minute, second: 0, of: Date()) ?? Date() },
            set: { date in
                let c = Calendar.utc.dateComponents([.hour, .minute], from: date)
                rule.hour = c.hour ?? 9
                rule.minute = c.minute ?? 0
            })
    }

    private func limitField(_ title: String, text: Binding<String>, example: String) -> some View {
        HStack {
            Text(title).font(PerpetoFont.body).foregroundStyle(PerpetoColor.ink)
            Spacer()
            TextField("No limit", text: text, prompt: Text("No limit").foregroundStyle(PerpetoColor.muted))
                .multilineTextAlignment(.trailing)
                .perpetoField()
                .frame(width: 140)
                .help("For example \(example)")
        }
    }

    /// "2M", "500k" or "2000000"; empty or invalid means no limit.
    static func parse(_ text: String) -> Int? {
        let t = text.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: ",", with: "")
        guard !t.isEmpty else { return nil }
        let multiplier: Double = t.hasSuffix("m") ? 1_000_000 : t.hasSuffix("k") ? 1_000 : 1
        guard let value = Double(multiplier == 1 ? t : String(t.dropLast())), value > 0 else { return nil }
        return Int((value * multiplier).rounded())
    }
}
