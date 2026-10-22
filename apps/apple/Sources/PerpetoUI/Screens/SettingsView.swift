import PerpetoKit
import SwiftUI

/// Light, dark or follow the system. Stored in UserDefaults under
/// `perpeto.appearance`; `-perpeto.appearance dark` on the command line
/// overrides it for one launch (snapshots use this).
public enum AppearanceMode: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark

    public static let defaultsKey = "perpeto.appearance"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    /// For `.preferredColorScheme(_:)`: nil follows the system.
    public var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    /// The stored choice, for code that runs before SwiftUI (the app delegate).
    public static var current: AppearanceMode {
        UserDefaults.standard.string(forKey: defaultsKey).flatMap(AppearanceMode.init(rawValue:)) ?? .system
    }
}

/// The appearance card: a title, one sentence and the pill segmented control.
public struct AppearanceSettings: View {
    @AppStorage(AppearanceMode.defaultsKey) private var appearance: AppearanceMode = .system

    public init() {}

    public var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Appearance").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                Text("Pure white or graphite. System follows your \(device) setting.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            PillPicker(AppearanceMode.allCases.map { ($0, $0.title) }, selection: $appearance)
        }
        .card()
    }

    #if os(macOS)
    private var device: String { "Mac" }
    #else
    private var device: String { "device" }
    #endif
}

/// Settings: appearance, then the hub connection. The Mac shows it as the
/// Settings window (⌘,), iOS as a sheet.
public struct SettingsView: View {
    var store: FactoryStore

    public init(store: FactoryStore) {
        self.store = store
    }

    public var body: some View {
        #if os(macOS)
        content.frame(width: 580)
        #else
        ScrollView { content }.background(PerpetoColor.canvas)
        #endif
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: PerpetoGap.cards) {
            AppearanceSettings()
            if store.isDemo { DemoSettings(store: store) }
            HubConnectionView(store: store, embedded: true)
        }
        .padding(PerpetoSpacing.x(6))
        .background(PerpetoColor.canvas)
    }
}

/// Without a hub: which demo factory to show. Observe only has no projects
/// and shows T3 Code sessions and subscriptions on two Macs.
struct DemoSettings: View {
    var store: FactoryStore
    @AppStorage(DemoScenario.defaultsKey) private var scenario: DemoScenario = .full

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(4)) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Demo data").font(PerpetoFont.heading).foregroundStyle(PerpetoColor.ink)
                Text("Shown until a hub is connected. Observe only is the factory with no projects: sessions, machines and subscriptions.")
                    .font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            PillPicker(DemoScenario.allCases.map { ($0, $0.title) }, selection: $scenario)
        }
        .card()
        .onChange(of: scenario) { _, next in
            Task { await store.use(DemoDataSource(scenario: next)) }
        }
    }
}
