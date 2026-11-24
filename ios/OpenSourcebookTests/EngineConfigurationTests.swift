import XCTest
@testable import OpenSourcebook

final class EngineConfigurationTests: XCTestCase {

    private let goodToken = "abcd1234efgh5678.ijkl"
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        suiteName = "OpenSourcebookTests.EngineConfiguration.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private func resolve(info: [String: Any] = [:]) -> EngineConfiguration {
        EngineConfiguration.from(userDefaults: defaults, infoDictionary: info)
    }

    func testNothingProvidedLeavesGenerationDisabled() {
        let config = resolve()
        XCTAssertEqual(config.baseURL?.host, "disabled.invalid")
        XCTAssertNil(config.clientToken)
        XCTAssertFalse(config.isConfigured)
        XCTAssertEqual(config.validationErrorMessage, "Use a deployed HTTPS engine endpoint.")
        XCTAssertNil(config.healthURL)
        XCTAssertNil(config.jobsURL)
        XCTAssertNil(config.formatsURL)
    }

    func testDefaultInitializerIsAlsoDisabled() {
        XCTAssertFalse(EngineConfiguration().isConfigured)
    }

    func testInfoDictionaryValuesConfigureTheEngine() {
        let config = resolve(info: [
            EngineConfiguration.infoBaseURLKey: "https://engine.example.com/",
            EngineConfiguration.infoClientTokenKey: goodToken
        ])
        XCTAssertTrue(config.isConfigured)
        XCTAssertNil(config.validationErrorMessage)
        XCTAssertEqual(config.baseURL?.absoluteString, "https://engine.example.com", "trailing slash is dropped")
        XCTAssertEqual(config.jobsURL?.absoluteString, "https://engine.example.com/v1/jobs")
        XCTAssertEqual(config.formatsURL?.absoluteString, "https://engine.example.com/v1/formats")
        XCTAssertEqual(config.healthURL?.absoluteString, "https://engine.example.com/health")
        XCTAssertEqual(config.statusMessage, "Cloud engine configured.")
    }

    func testUserDefaultsBeatTheInfoDictionary() {
        defaults.set("https://saved.example.com", forKey: EngineConfiguration.engineBaseURLKey)
        defaults.set("savedtoken1234567890", forKey: EngineConfiguration.engineClientTokenKey)
        let config = resolve(info: [
            EngineConfiguration.infoBaseURLKey: "https://built-in.example.com",
            EngineConfiguration.infoClientTokenKey: goodToken
        ])
        XCTAssertEqual(config.baseURL?.host, "saved.example.com")
        XCTAssertEqual(config.clientToken, "savedtoken1234567890")
    }

    func testBlankSavedValuesFallBackToTheInfoDictionary() {
        defaults.set("   ", forKey: EngineConfiguration.engineBaseURLKey)
        defaults.set("", forKey: EngineConfiguration.engineClientTokenKey)
        let config = resolve(info: [
            EngineConfiguration.infoBaseURLKey: "https://built-in.example.com",
            EngineConfiguration.infoClientTokenKey: goodToken
        ])
        XCTAssertEqual(config.baseURL?.host, "built-in.example.com")
        XCTAssertEqual(config.clientToken, goodToken)
        XCTAssertTrue(config.isConfigured)
    }

    func testValuesAreTrimmed() {
        let config = resolve(info: [
            EngineConfiguration.infoBaseURLKey: "  https://engine.example.com  ",
            EngineConfiguration.infoClientTokenKey: "  \(goodToken)\n"
        ])
        XCTAssertEqual(config.baseURL?.host, "engine.example.com")
        XCTAssertEqual(config.clientToken, goodToken)
    }

    func testAMissingTokenKeepsItDisabledButHealthStaysAvailable() {
        let config = resolve(info: [EngineConfiguration.infoBaseURLKey: "https://engine.example.com"])
        XCTAssertFalse(config.isConfigured)
        XCTAssertEqual(config.validationErrorMessage, "The client token is missing or invalid.")
        XCTAssertNotNil(config.healthURL, "the health check does not need a token")
        XCTAssertNil(config.jobsURL)
    }

    func testTokenShapeIsValidated() {
        func configured(_ token: String) -> Bool {
            resolve(info: [
                EngineConfiguration.infoBaseURLKey: "https://engine.example.com",
                EngineConfiguration.infoClientTokenKey: token
            ]).isConfigured
        }
        XCTAssertTrue(configured(String(repeating: "a", count: 16)))
        XCTAssertFalse(configured(String(repeating: "a", count: 15)), "too short")
        XCTAssertTrue(configured(String(repeating: "a", count: 256)))
        XCTAssertFalse(configured(String(repeating: "a", count: 257)), "too long")
        XCTAssertFalse(configured("has a space inside!!"), "characters outside the allowed set")
        XCTAssertTrue(configured("Aa0._~:-Aa0._~:-Aa0"))
    }

    func testHTTPEndpointsAreRejectedOutsideTheSimulatorLocalhost() {
        let config = resolve(info: [
            EngineConfiguration.infoBaseURLKey: "http://engine.example.com",
            EngineConfiguration.infoClientTokenKey: goodToken
        ])
        XCTAssertFalse(config.isConfigured)
        XCTAssertEqual(config.validationErrorMessage, "The engine endpoint must use HTTPS.")
        XCTAssertNil(config.healthURL)
    }

    func testANonHTTPSchemeHasNoEndpointAtAll() {
        let config = resolve(info: [
            EngineConfiguration.infoBaseURLKey: "ftp://engine.example.com",
            EngineConfiguration.infoClientTokenKey: goodToken
        ])
        XCTAssertNil(config.baseURL)
        XCTAssertFalse(config.isConfigured)
        XCTAssertEqual(config.validationErrorMessage, "Enter an engine endpoint.")
    }

    func testStatusAndValidationMessagesNeverContainTheToken() {
        let configs = [
            resolve(info: [
                EngineConfiguration.infoBaseURLKey: "http://engine.example.com",
                EngineConfiguration.infoClientTokenKey: goodToken
            ]),
            resolve(info: [
                EngineConfiguration.infoBaseURLKey: "https://engine.example.com",
                EngineConfiguration.infoClientTokenKey: goodToken
            ])
        ]
        for config in configs {
            XCTAssertFalse(config.statusMessage.contains(goodToken))
            XCTAssertFalse((config.validationErrorMessage ?? "").contains(goodToken))
        }
    }

    func testIntervalsHaveAOneSecondFloor() {
        let config = EngineConfiguration(pollInterval: 0, requestTimeout: -4)
        XCTAssertEqual(config.pollInterval, 1)
        XCTAssertEqual(config.requestTimeout, 1)
    }
}

final class LaunchEnvironmentTests: XCTestCase {

    func testUITestingArgumentOrXCTestEnvironmentMeansTesting() {
        XCTAssertTrue(LaunchEnvironment.isTesting(arguments: ["OpenSourcebook", "-uiTesting"], environment: [:]))
        XCTAssertTrue(LaunchEnvironment.isTesting(arguments: ["OpenSourcebook"], environment: ["XCTestConfigurationFilePath": "/x"]))
        XCTAssertFalse(LaunchEnvironment.isTesting(arguments: ["OpenSourcebook"], environment: [:]))
    }
}
