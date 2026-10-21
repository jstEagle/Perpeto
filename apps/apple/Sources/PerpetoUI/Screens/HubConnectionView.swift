import PerpetoKit
import PerpetoUI
import SwiftUI

/// Hub address in UserDefaults; owner token in the Keychain only.
struct SettingsView: View {
    var store: FactoryStore
    private let settings = HubSettings()

    @State private var url = ""
    @State private var token = ""
    @State private var hasToken = false
    @State private var status: (String, StatusTone)?
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: PerpetoSpacing.x(5)) {
            HStack(spacing: PerpetoSpacing.x(3)) {
                SpindleShape().fill(PerpetoColor.ink).frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Hub connection").font(PerpetoFont.title()).foregroundStyle(PerpetoColor.ink)
                    Text("Without a hub, the app shows demo data that stays on this Mac.").font(PerpetoFont.body).foregroundStyle(PerpetoColor.muted)
                }
            }
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
                Text("Hub address").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
                TextField("https://hub.example.com", text: $url).font(PerpetoFont.mono(PerpetoType.text14)).perpetoField()
                Text("HTTPS is required except for localhost.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
            VStack(alignment: .leading, spacing: PerpetoSpacing.x(1.5)) {
                Text("Owner token").font(PerpetoFont.captionMedium).foregroundStyle(PerpetoColor.muted)
                SecureField(hasToken ? "Saved in Keychain. Enter a new token to replace it." : "Paste the owner token", text: $token).perpetoField()
                Text("Stored in your login Keychain. It is never written to preferences or logs.").font(PerpetoFont.caption).foregroundStyle(PerpetoColor.muted)
            }
            if let status { StatusLabel(status.0, tone: status.1) }
            HStack(spacing: PerpetoSpacing.x(2)) {
                if hasToken {
                    Button("Remove token", role: .destructive) {
                        settings.tokens.delete()
                        hasToken = false
                        Task { await store.use(DemoDataSource()) }
                        status = ("Token removed. Showing demo data.", .neutral)
                    }
                    .buttonStyle(.perpetoGhost)
                }
                Spacer()
                Button("Test connection") { Task { await test() } }
                    .buttonStyle(.perpetoSecondary)
                    .disabled(url.isEmpty || working)
                Button("Save and connect") { Task { await save() } }
                    .buttonStyle(.perpetoPrimary)
                    .keyboardShortcut(.defaultAction)
                    .disabled(url.isEmpty || (!hasToken && token.isEmpty) || working)
            }
        }
        .padding(PerpetoSpacing.x(6))
        .frame(width: 520)
        .background(PerpetoColor.surface)
        .onAppear {
            url = settings.hubURLString
            hasToken = settings.tokens.read() != nil
        }
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
