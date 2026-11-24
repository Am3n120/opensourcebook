import Foundation

/// How the process was started. Tests must never touch the owner's data, so a
/// UI test passes `-uiTesting`, and a unit-test run hosted by the app is
/// detected from the environment XCTest sets. Either one makes `OpenSourcebookApp` use an
/// in-memory store, skip the share inbox and leave the engine unconfigured.
enum LaunchEnvironment {
    static let uiTestingArgument = "-uiTesting"

    static var isTesting: Bool {
        isTesting(
            arguments: ProcessInfo.processInfo.arguments,
            environment: ProcessInfo.processInfo.environment
        )
    }

    static func isTesting(arguments: [String], environment: [String: String]) -> Bool {
        arguments.contains(uiTestingArgument) || environment["XCTestConfigurationFilePath"] != nil
    }

    /// Environment key a UI test sets to hand the app items to play: a JSON
    /// array of outputs, which go into the in-memory store. The items live in
    /// the UI test target; the app ships none.
    static let testOutputsKey = "OPENSOURCEBOOK_TEST_OUTPUTS"

    /// The items a test handed over; empty outside a test or when there are none.
    static func testOutputs(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> [Output] {
        guard isTesting(arguments: arguments, environment: environment),
              let json = environment[testOutputsKey] else { return [] }
        return (try? JSONDecoder().decode([Output].self, from: Data(json.utf8))) ?? []
    }

    /// Environment key a UI test sets to stand in for the engine's Studio
    /// routes: a JSON `RecordedStudio`. The answers live in the UI test
    /// target; the app ships none.
    static let testStudioKey = "OPENSOURCEBOOK_TEST_STUDIO"

    /// The Studio answers a test handed over; nil outside a test or when there are none.
    static func testStudio(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> RecordedStudio? {
        guard isTesting(arguments: arguments, environment: environment),
              let json = environment[testStudioKey] else { return nil }
        return try? RecordedStudio.decode(Data(json.utf8))
    }
}
