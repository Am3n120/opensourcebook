import Foundation

/// A quiz's payload (DECISIONS.md #35), as the engine writes it for format
/// `quiz` (engine/src/engines/quiz/schema.ts, schema version 1). Question
/// kinds are open: a kind this build doesn't know still decodes, shows that
/// it can't be answered here, and counts as skipped.
struct QuizPayload: Codable, Sendable, Equatable, Hashable {
    enum FeedbackTiming: String, Codable, Sendable {
        case afterEach, atEnd
    }

    var title: String
    /// 0...1.
    var passMark: Double
    var feedback: FeedbackTiming
    var questions: [QuizQuestion]

    private enum CodingKeys: String, CodingKey {
        case title, passMark, feedback, questions
    }

    init(title: String, passMark: Double, feedback: FeedbackTiming, questions: [QuizQuestion]) {
        self.title = title
        self.passMark = passMark
        self.feedback = feedback
        self.questions = questions
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        passMark = try c.decodeIfPresent(Double.self, forKey: .passMark) ?? 0
        feedback = (try? c.decodeIfPresent(FeedbackTiming.self, forKey: .feedback)) ?? .afterEach
        questions = try c.decode(LossyList<QuizQuestion>.self, forKey: .questions).elements
    }
}

struct QuizQuestion: Codable, Sendable, Equatable, Hashable, Identifiable {
    struct Feedback: Codable, Sendable, Equatable, Hashable {
        var correct: String
        var incorrect: String
    }

    enum Body: Sendable, Equatable, Hashable {
        /// One right option among several.
        case choice(options: [String], answer: Int, optionFeedback: [String]?)
        /// A problem worked in steps, each checked before the next opens.
        case worked(steps: [WorkedStep])
        /// A kind this build doesn't know; the raw question is kept.
        case unknown(kind: String, raw: JSONValue)
    }

    let id: String
    var topic: String
    var prompt: String
    /// Optional LaTeX shown under the prompt.
    var display: String?
    var points: Double
    var feedback: Feedback
    var body: Body
    /// Where the question came from, kept as sent.
    var cites: [JSONValue]

    var kind: String {
        switch body {
        case .choice: "choice"
        case .worked: "worked"
        case .unknown(let kind, _): kind
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, topic, prompt, display, points, feedback, cites
        case options, answer, optionFeedback, steps
    }

    init(id: String, topic: String, prompt: String, display: String? = nil, points: Double = 1,
         feedback: Feedback = Feedback(correct: "", incorrect: ""), body: Body, cites: [JSONValue] = []) {
        self.id = id
        self.topic = topic
        self.prompt = prompt
        self.display = display
        self.points = points
        self.feedback = feedback
        self.body = body
        self.cites = cites
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        topic = try c.decodeIfPresent(String.self, forKey: .topic) ?? ""
        prompt = try c.decode(String.self, forKey: .prompt)
        display = try c.decodeIfPresent(String.self, forKey: .display)
        points = try c.decodeIfPresent(Double.self, forKey: .points) ?? 1
        feedback = (try? c.decodeIfPresent(Feedback.self, forKey: .feedback)) ?? Feedback(correct: "", incorrect: "")
        cites = (try? c.decodeIfPresent([JSONValue].self, forKey: .cites)) ?? []
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "choice":
            body = .choice(options: try c.decode([String].self, forKey: .options),
                           answer: try c.decode(Int.self, forKey: .answer),
                           optionFeedback: try c.decodeIfPresent([String].self, forKey: .optionFeedback))
        case "worked":
            body = .worked(steps: try c.decode([WorkedStep].self, forKey: .steps))
        default:
            body = .unknown(kind: kind, raw: try JSONValue(from: decoder))
        }
    }

    func encode(to encoder: Encoder) throws {
        if case .unknown(_, let raw) = body {
            try raw.encode(to: encoder)
            return
        }
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(kind, forKey: .kind)
        try c.encode(topic, forKey: .topic)
        try c.encode(prompt, forKey: .prompt)
        try c.encodeIfPresent(display, forKey: .display)
        try c.encode(points, forKey: .points)
        try c.encode(feedback, forKey: .feedback)
        try c.encode(cites, forKey: .cites)
        switch body {
        case .choice(let options, let answer, let optionFeedback):
            try c.encode(options, forKey: .options)
            try c.encode(answer, forKey: .answer)
            try c.encodeIfPresent(optionFeedback, forKey: .optionFeedback)
        case .worked(let steps):
            try c.encode(steps, forKey: .steps)
        case .unknown:
            break
        }
    }
}

struct WorkedStep: Codable, Sendable, Equatable, Hashable {
    enum Input: Sendable, Equatable, Hashable {
        /// Short answers typed in order.
        case entries(values: [String])
        /// A pick between options.
        case choice(options: [String], answer: Int)
    }

    var prompt: String
    var hint: String?
    var input: Input

    private enum CodingKeys: String, CodingKey {
        case prompt, hint, input, values, options, answer
    }

    init(prompt: String, hint: String? = nil, input: Input) {
        self.prompt = prompt
        self.hint = hint
        self.input = input
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        prompt = try c.decode(String.self, forKey: .prompt)
        hint = try c.decodeIfPresent(String.self, forKey: .hint)
        if try c.decodeIfPresent(String.self, forKey: .input) == "choice" {
            input = .choice(options: try c.decode([String].self, forKey: .options),
                            answer: try c.decode(Int.self, forKey: .answer))
        } else {
            input = .entries(values: try c.decodeIfPresent([String].self, forKey: .values) ?? [])
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(prompt, forKey: .prompt)
        try c.encodeIfPresent(hint, forKey: .hint)
        switch input {
        case .entries(let values):
            try c.encode("entries", forKey: .input)
            try c.encode(values, forKey: .values)
        case .choice(let options, let answer):
            try c.encode("choice", forKey: .input)
            try c.encode(options, forKey: .options)
            try c.encode(answer, forKey: .answer)
        }
    }
}

// MARK: - Answers and grading

/// What the person gave for one question.
enum QuizResponse: Sendable, Equatable, Hashable {
    case choice(Int)
    case worked([WorkedStepResponse])
}

struct WorkedStepResponse: Sendable, Equatable, Hashable {
    enum Value: Sendable, Equatable, Hashable {
        case entries([String])
        case choice(Int)
    }

    var value: Value?
    /// The person asked to see the answer; the step then doesn't count.
    var revealed = false
}

/// The result a finished quiz reports with its done tick
/// (`item_results.result_json`). Computed the way the engine's `gradeQuiz`
/// does, so web and phone report the same numbers.
struct QuizResult: Encodable, Sendable, Equatable {
    enum Outcome: String, Encodable, Sendable {
        case right, partial, wrong, skipped
    }

    struct Question: Encodable, Sendable, Equatable {
        let id: String
        let topic: String
        let outcome: Outcome
        let earned: Double
        let points: Double
    }

    struct Topic: Encodable, Sendable, Equatable {
        let topic: String
        var earned: Double
        var points: Double
    }

    let format = "quiz"
    let version = 1
    let score: Double
    let earned: Double
    let total: Double
    let correct: Int
    let answered: Int
    let count: Int
    let passMark: Double
    let passed: Bool
    let questions: [Question]
    let missed: [String]
    let topicsMissed: [String]
    let topics: [Topic]

    /// As JSON, for the done tick.
    var json: JSONValue? {
        (try? JSONEncoder().encode(self)).flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
    }
}

enum QuizGrader {
    /// 0...1 of a question's points, and whether it was answered at all.
    static func grade(_ question: QuizQuestion, _ response: QuizResponse?) -> (fraction: Double, answered: Bool) {
        switch (question.body, response) {
        case (.choice(_, let answer, _), .choice(let picked)?):
            return (picked == answer ? 1 : 0, true)
        case (.worked(let steps), .worked(let given)?):
            guard !given.isEmpty, !steps.isEmpty else { return (0, false) }
            let right = steps.enumerated().filter { index, step in
                guard index < given.count, !given[index].revealed, let value = given[index].value else { return false }
                return isRight(value, for: step)
            }.count
            return (Double(right) / Double(steps.count), true)
        default:
            return (0, false)
        }
    }

    static func isRight(_ value: WorkedStepResponse.Value, for step: WorkedStep) -> Bool {
        switch (step.input, value) {
        case (.choice(_, let answer), .choice(let picked)):
            return picked == answer
        case (.entries(let expected), .entries(let typed)):
            return typed.count == expected.count && zip(typed, expected).allSatisfy(sameAnswer)
        default:
            return false
        }
    }

    static func result(_ quiz: QuizPayload, responses: [String: QuizResponse]) -> QuizResult {
        let questions = quiz.questions.map { question -> QuizResult.Question in
            let grade = grade(question, responses[question.id])
            let fraction = min(1, max(0, grade.fraction))
            let outcome: QuizResult.Outcome = !grade.answered ? .skipped : fraction == 1 ? .right : fraction == 0 ? .wrong : .partial
            return .init(id: question.id, topic: question.topic, outcome: outcome,
                         earned: round(question.points * fraction), points: question.points)
        }
        var topics: [QuizResult.Topic] = []
        for question in questions {
            if let index = topics.firstIndex(where: { $0.topic == question.topic }) {
                topics[index].earned = round(topics[index].earned + question.earned)
                topics[index].points = round(topics[index].points + question.points)
            } else {
                topics.append(.init(topic: question.topic, earned: question.earned, points: question.points))
            }
        }
        let earned = round(questions.reduce(0) { $0 + $1.earned })
        let total = round(questions.reduce(0) { $0 + $1.points })
        let score = total > 0 ? round(earned / total) : 0
        let weakest = topics.filter { $0.earned < $0.points }
            .enumerated()
            .sorted { ($0.element.earned / $0.element.points, $0.offset) < ($1.element.earned / $1.element.points, $1.offset) }
            .map(\.element.topic)
        return QuizResult(
            score: score, earned: earned, total: total,
            correct: questions.filter { $0.outcome == .right }.count,
            answered: questions.filter { $0.outcome != .skipped }.count,
            count: questions.count, passMark: quiz.passMark, passed: score >= quiz.passMark,
            questions: questions,
            missed: questions.filter { $0.outcome != .right }.map(\.id),
            topicsMissed: weakest, topics: topics
        )
    }

    /// Typed answers compare like the engine's: case, spacing, minus signs
    /// and number forms (0.5, 1/2) don't matter.
    static func sameAnswer(_ given: String, _ expected: String) -> Bool {
        let a = normalize(given), b = normalize(expected)
        if a == b { return true }
        guard let x = number(a), let y = number(b) else { return false }
        return abs(x - y) <= 1e-9 * max(1, abs(y))
    }

    private static func normalize(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .replacingOccurrences(of: "[−–—]", with: "-", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    private static func number(_ value: String) -> Double? {
        if let match = value.wholeMatch(of: /(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/),
           let top = Double(match.1), let bottom = Double(match.2) {
            return bottom == 0 ? nil : top / bottom
        }
        guard value.wholeMatch(of: /-?(\d+\.?\d*|\.\d+)(e-?\d+)?/) != nil else { return nil }
        return Double(value)
    }

    private static func round(_ value: Double) -> Double {
        (value * 10_000).rounded() / 10_000
    }
}
