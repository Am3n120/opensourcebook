import OSLog
import SwiftData
import SwiftUI

/// App entry. Builds the SwiftData container, the output store and the
/// generation service once, and injects them as environment objects. Drains
/// the share-extension inbox into capture jobs on launch and on foreground.
@main
struct OpenSourcebookApp: App {
    private let modelContainer: ModelContainer?
    @StateObject private var store: OutputStore
    @StateObject private var generationService: GenerationService
    @StateObject private var appState = AppState()
    @StateObject private var doneTicks: DoneTickStore
    @StateObject private var studio: StudioStore
    /// Nil under test: the bundled formats stand and nothing is fetched.
    private let formatService: FormatService?
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let logger = Logger(subsystem: "app.opensourcebook", category: "App")
        let schema = Schema(OpenSourcebookModelSchema.models)
        let container: ModelContainer?
        let store: OutputStore
        let isTesting = LaunchEnvironment.isTesting

        do {
            // Under test the store is in memory: the owner's library is never touched.
            let persistent = try ModelContainer(
                for: schema,
                configurations: ModelConfiguration(isStoredInMemoryOnly: isTesting)
            )
            container = persistent
            store = OutputStore(modelContext: persistent.mainContext)
        } catch {
            logger.error("Persistent model container failed: \(error.localizedDescription, privacy: .public)")
            do {
                let inMemory = try ModelContainer(
                    for: schema,
                    configurations: ModelConfiguration(isStoredInMemoryOnly: true)
                )
                container = inMemory
                store = OutputStore(modelContext: inMemory.mainContext)
                logger.notice("Using an in-memory model container for this launch")
            } catch {
                logger.error("In-memory model container failed: \(error.localizedDescription, privacy: .public)")
                container = nil
                store = OutputStore()
            }
        }

        self.modelContainer = container
        for output in LaunchEnvironment.testOutputs() { store.upsert(output) }
        _store = StateObject(wrappedValue: store)
        if isTesting {
            formatService = nil
        } else {
            let formats = FormatService(configuration: .current)
            formats.loadCached()
            formatService = formats
        }
        let doneTicks = isTesting
            ? DoneTickStore(defaults: UserDefaults(suiteName: "opensourcebook.tests.doneTicks.\(UUID().uuidString)") ?? .standard)
            : DoneTickStore(syncer: DoneTickService(configuration: .current))
        _doneTicks = StateObject(wrappedValue: doneTicks)
        // Under test the Studio is what the test handed over, or nothing; never the owner's engine or cache.
        let engine = EngineConfiguration.current
        _studio = StateObject(wrappedValue: isTesting
            ? StudioStore(client: LaunchEnvironment.testStudio() ?? NoStudio(), outputs: store, doneTicks: doneTicks)
            : StudioStore(client: StudioService(configuration: engine), outputs: store, doneTicks: doneTicks,
                          cacheURL: StudioStore.defaultCacheURL, engineKey: engine.baseURL?.absoluteString))
        // Under test the engine stays unconfigured: no saved endpoint or token is read.
        _generationService = StateObject(wrappedValue: GenerationService(
            store: store,
            configuration: isTesting ? EngineConfiguration() : .current
        ))
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environmentObject(store)
                .environmentObject(appState)
                .environmentObject(doneTicks)
                .environmentObject(studio)
                .environment(\.citeSources, CiteSources(studio: studio))
                .environmentObject(generationService)
                .modifier(ModelContainerModifier(container: modelContainer))
                .task {
                    if !LaunchEnvironment.isTesting { ShareInboxBridge.drain(into: store) }
                    generationService.start()
                    await doneTicks.flush()
                    await formatService?.refresh()
                }
                .onChange(of: store.projects, initial: true) { _, projects in
                    if !LaunchEnvironment.isTesting { ShareInboxBridge.publishProjects(projects) }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                // Shares saved while Open Sourcebook was in the background become jobs now.
                if !LaunchEnvironment.isTesting { ShareInboxBridge.drain(into: store) }
                generationService.start()
                Task { await doneTicks.flush() }
            case .inactive, .background: generationService.stop()
            @unknown default: generationService.stop()
            }
        }
    }
}

private struct ModelContainerModifier: ViewModifier {
    let container: ModelContainer?

    func body(content: Content) -> some View {
        if let container {
            content.modelContainer(container)
        } else {
            content
        }
    }
}
