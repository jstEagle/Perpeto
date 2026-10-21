import PerpetoKit
import SwiftUI

/// Hub address in UserDefaults; owner token in the Keychain only. macOS shows
/// it as the Settings window, iOS as a sheet.
public struct HubConnectionView: View {
    var store: FactoryStore
    /// Inside `SettingsView`, which supplies the page padding and canvas.
    var embedded: Bool
    private let settings = HubSettings()

    public init(store: FactoryStore, embedded: Bool = false) {
        self.store = store
        self.embedded = embedded
    }

    @State private var url = ""
    @State private var token = ""
    @State private var hasToken = false
    @State private var status: (String, StatusTone)?
    @State private var working = false

    #if os(macOS)
    private let device = "this Mac"
    private let keychain = "your login Keychain"
    #else
    private let device = "this device"
    private let keychain = "the Keychain on this device"
    #endif

    public var body: some View {
        if embedded {
            form
        } else {
            #if os(macOS)
            page.frame(width: 580)
            #else
            ScrollView { page }.background(PerpetoColor.canvas)
            #endif
        }
    }

    private var page: some View {
        form.padding(PerpetoSpacing.x(6)).background(PerpetoColor.canvas)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            HStack(spacing: PerpetoSpacing.x(3)) {
                SpindleShape().fill(PerpetoColor.ink).frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hub connection").font(PerpetoType.title(PerpetoType.text24)).foregroundStyle(PerpetoColor.ink)
                    Text("Without a hub, the app shows demo data that stays on \(device).").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
                Text("Hub address").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink)
                TextField("Hub address", text: $url, prompt: Text(verbatim: "https://hub.example.com").foregroundStyle(PerpetoColor.muted)).font(PerpetoFont.mono(PerpetoType.text14)).perpetoField()
                    #if os(iOS)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    #endif
                Text("HTTPS is required except for localhost.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
                Text("Owner token").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.ink)
                SecureField(hasToken ? "Saved in Keychain. Enter a new token to replace it." : "Paste the owner token", text: $token).perpetoField()
                Text("Stored in \(keychain). It is never written to preferences or logs.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let status { StatusLabel(status.0, tone: status.1) }
            #if os(macOS)
            HStack(spacing: PerpetoSpacing.x(2)) {
                removeButton
                Spacer()
                testButton
                saveButton
            }
            #else
            VStack(spacing: PerpetoSpacing.x(3)) {
                saveButton.controlSize(.large)
                testButton.controlSize(.large)
                removeButton
            }
            .fullWidthButtons()
            #endif
        }
        .card()
        .onAppear {
            url = settings.hubURLString
            hasToken = settings.tokens.read() != nil
        }
    }

    @ViewBuilder
    private var removeButton: some View {
        if hasToken {
            Button("Remove token", role: .destructive) {
                settings.tokens.delete()
                hasToken = false
                Task { await store.use(DemoDataSource()) }
                status = ("Token removed. Showing demo data.", .neutral)
            }
            .buttonStyle(.perpetoGhost)
        }
    }

    private var testButton: some View {
        Button("Test connection") { Task { await test() } }
            .buttonStyle(.perpetoSecondary)
            .disabled(url.isEmpty || working)
    }

    private var saveButton: some View {
        Button("Save and connect") { Task { await save() } }
            .buttonStyle(.perpetoPrimary)
            .keyboardShortcut(.defaultAction)
            .disabled(url.isEmpty || (!hasToken && token.isEmpty) || working)
    }

    private func client() throws -> HubClient {
        guard let parsed = URL(string: url.trimmingCharacters(in: .whitespaces)) else { throw HubError.invalidURL }
        let secret = token.isEmpty ? (settings.tokens.read() ?? "") : token
        return try HubClient(baseURL: parsed, token: secret)
    }

    private func test() async {
        working = true
        defer { working = false }
        do {
            let client = try client()
            let health = try await client.health()
            _ = try await client.overview()
            status = ("Connected\(health.version.map { " to hub \($0)" } ?? ""). Token accepted.", .success)
        } catch {
            status = ((error as? LocalizedError)?.errorDescription ?? "Connection failed.", .error)
        }
    }

    private func save() async {
        working = true
        defer { working = false }
        do {
            let client = try client()
            settings.setHubURL(url)
            if !token.isEmpty {
                guard settings.tokens.write(token) else {
                    status = ("Saving the token to Keychain failed. Nothing was changed.", .error)
                    return
                }
                token = ""
                hasToken = true
            }
            await store.use(HubDataSource(client: client))
            status = store.lastError.map { ($0, .error) } ?? ("Connected. Showing hub data.", .success)
        } catch {
            status = ((error as? LocalizedError)?.errorDescription ?? "Saving failed.", .error)
        }
    }
}
