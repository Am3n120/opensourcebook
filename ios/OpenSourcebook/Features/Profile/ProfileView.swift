import OSLog
import SwiftUI

/// Settings: engine connection, haptics, export, about. Only controls that
/// take effect live here (DECISIONS.md #9, #11: no account, plans or storage
/// meter; the engine settings are the real ones from EngineConfiguration).
struct ProfileView: View {
    @EnvironmentObject private var store: OutputStore
    @EnvironmentObject private var generation: GenerationService

    @AppStorage(OpenSourcebookHaptics.enabledKey) private var hapticsEnabled = true

    @State private var baseURLText = ""
    @State private var tokenText = ""
    @State private var connectionState: ConnectionState = .idle
    @State private var exportDocument: OpenSourcebookExportDocument?
    @State private var isExporting = false
    @State private var exportMessage: String?

    private static let logger = Logger(subsystem: "app.opensourcebook", category: "Profile")

    private enum ConnectionState: Equatable {
        case idle
        case checking
        case result(GenerationService.ConnectionResult)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xl) {
                Text("Profile")
                    .font(OpenSourcebookTheme.Fonts.title)
                    .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)

                engineSection
                preferencesSection
                dataSection
                aboutSection
            }
            .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
            .padding(.top, OpenSourcebookTheme.Spacing.sm)
            .padding(.bottom, OpenSourcebookTheme.Spacing.xl)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(OpenSourcebookTheme.Colors.background)
        .navigationBarHidden(true)
        .onAppear(perform: loadSettings)
        .fileExporter(
            isPresented: $isExporting,
            document: exportDocument,
            contentType: .json,
            defaultFilename: "opensourcebook-export"
        ) { result in
            switch result {
            case .success:
                exportMessage = "Export saved."
            case .failure(let error):
                Self.logger.error("Export failed: \(error.localizedDescription, privacy: .public)")
                exportMessage = "Could not save the export: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Engine

    private var engineSection: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            SectionHeader("Engine")
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
                field("Endpoint") {
                    TextField("https://", text: $baseURLText)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("profile-engine-url")
                }
                field("Client token") {
                    SecureField("Token", text: $tokenText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("profile-engine-token")
                }

                Text(generation.configuration.validationErrorMessage ?? generation.statusMessage)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)

                HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                    actionButton("Save", filled: true, action: save)
                        .disabled(!hasChanges)
                    actionButton("Check connection", filled: false) {
                        Task { await checkConnection() }
                    }
                    .disabled(connectionState == .checking)
                }

                connectionStatus
            }
            .padding(OpenSourcebookTheme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)
        }
    }

    @ViewBuilder
    private var connectionStatus: some View {
        switch connectionState {
        case .idle:
            EmptyView()
        case .checking:
            HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                ProgressView()
                Text("Checking...")
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
        case .result(let result):
            let ok = result == .connected
            Label(result.message, systemImage: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(ok ? OpenSourcebookTheme.Colors.successText : OpenSourcebookTheme.Colors.accentText)
        }
    }

    // MARK: - Preferences

    private var preferencesSection: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            SectionHeader("Preferences")
            Toggle(isOn: $hapticsEnabled) {
                Text("Haptics")
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
            }
            .tint(OpenSourcebookTheme.Colors.primary)
            .onChange(of: hapticsEnabled) { _, isOn in
                if isOn { OpenSourcebookHaptics.lightImpact() }
            }
            .padding(OpenSourcebookTheme.Spacing.md)
            .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)
            .accessibilityIdentifier("profile-haptics")
        }
    }

    // MARK: - Data

    private var dataSection: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            SectionHeader("Your data")
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
                Text("Your library is private, never shared or used for training. Export everything as a JSON file.")
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                actionButton("Export as JSON", filled: false, action: export)
                if let exportMessage {
                    Text(exportMessage)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                }
            }
            .padding(OpenSourcebookTheme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
            SectionHeader("About")
            HStack {
                Text("Version")
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                Spacer()
                Text(versionText)
                    .font(OpenSourcebookTheme.Fonts.body)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
            .padding(OpenSourcebookTheme.Spacing.md)
            .openSourcebookCardStyle(cornerRadius: OpenSourcebookTheme.Radius.r20)
        }
    }

    private var versionText: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }

    // MARK: - Pieces

    private func field<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
            Text(title)
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            content()
                .font(OpenSourcebookTheme.Fonts.body)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .padding(OpenSourcebookTheme.Spacing.sm)
                .background(OpenSourcebookTheme.Colors.fill)
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
        }
    }

    private func actionButton(_ title: String, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(OpenSourcebookTheme.Fonts.bodySemibold)
                .foregroundStyle(filled ? Color.white : OpenSourcebookTheme.Colors.primary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, OpenSourcebookTheme.Spacing.sm)
                .background(filled ? OpenSourcebookTheme.Colors.primary : OpenSourcebookTheme.Colors.primarySoft)
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Actions

    private func loadSettings() {
        let defaults = UserDefaults.standard
        baseURLText = defaults.string(forKey: EngineConfiguration.engineBaseURLKey) ?? ""
        tokenText = defaults.string(forKey: EngineConfiguration.engineClientTokenKey) ?? ""
    }

    private var hasChanges: Bool {
        let defaults = UserDefaults.standard
        return trimmed(baseURLText) != (defaults.string(forKey: EngineConfiguration.engineBaseURLKey) ?? "")
            || trimmed(tokenText) != (defaults.string(forKey: EngineConfiguration.engineClientTokenKey) ?? "")
    }

    private func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func save() {
        let defaults = UserDefaults.standard
        persist(trimmed(baseURLText), forKey: EngineConfiguration.engineBaseURLKey, in: defaults)
        persist(trimmed(tokenText), forKey: EngineConfiguration.engineClientTokenKey, in: defaults)
        generation.reloadConfiguration()
        connectionState = .idle
        OpenSourcebookHaptics.lightImpact()
        Self.logger.notice("Engine settings saved")
    }

    private func persist(_ value: String, forKey key: String, in defaults: UserDefaults) {
        if value.isEmpty {
            defaults.removeObject(forKey: key)
        } else {
            defaults.set(value, forKey: key)
        }
    }

    private func checkConnection() async {
        if hasChanges { save() }
        connectionState = .checking
        let result = await generation.testConnection()
        connectionState = .result(result)
        Self.logger.notice("Engine health check: \(result == .connected ? "connected" : "failed", privacy: .public)")
    }

    private func export() {
        do {
            let data = try OpenSourcebookExportPayload(store: store, appVersion: versionText).encoded()
            exportDocument = OpenSourcebookExportDocument(data: data)
            exportMessage = nil
            isExporting = true
        } catch {
            Self.logger.error("Export encoding failed: \(error.localizedDescription, privacy: .public)")
            exportMessage = "Could not build the export: \(error.localizedDescription)"
        }
    }
}

#Preview {
    let store = OutputStore()
    return NavigationStack { ProfileView() }
        .environmentObject(store)
        .environmentObject(GenerationService(store: store))
}
