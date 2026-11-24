import SwiftUI

/// Plays a quiz (DECISIONS.md #35): its questions side by side, one per
/// screen, swiped sideways (#36), then a result. Feedback shows after each
/// answer or only at the end, as the quiz says. Finishing sends the result
/// with the item's done tick. A quiz has its own look: question cards and
/// answer buttons, not a byte's blocks.
struct QuizPlayerView: View {
    @EnvironmentObject private var doneTicks: DoneTickStore
    let output: Output

    @State private var page: Int?
    @State private var responses: [String: QuizResponse] = [:]
    @State private var isFinished = false

    var body: some View {
        if let quiz = output.quiz, !quiz.questions.isEmpty {
            VStack(spacing: 0) {
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 0) {
                        ForEach(Array(quiz.questions.enumerated()), id: \.element.id) { index, question in
                            QuizQuestionView(
                                question: question,
                                number: index + 1,
                                count: quiz.questions.count,
                                showsFeedback: quiz.feedback == .afterEach,
                                response: binding(for: question)
                            )
                            .containerRelativeFrame([.horizontal, .vertical])
                            .id(index)
                        }
                        QuizResultView(result: QuizGrader.result(quiz, responses: responses),
                                       quiz: quiz, isFinished: isFinished) {
                            finish(quiz)
                        }
                        .containerRelativeFrame([.horizontal, .vertical])
                        .id(quiz.questions.count)
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .scrollIndicators(.hidden)
                .scrollPosition(id: $page)
                .scrollDismissesKeyboard(.interactively)
                .accessibilityIdentifier("quiz-questions-\(output.id.uuidString)")

                BitPositionView(count: quiz.questions.count + 1, current: page ?? 0)
                    .accessibilityLabel(positionLabel(quiz))
                    .accessibilityIdentifier("quiz-position-\(output.id.uuidString)")
                    .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
            }
        } else {
            EmptyStateView(icon: "checkmark.circle", title: output.title,
                           message: "This quiz has no questions this build can play yet.")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func positionLabel(_ quiz: QuizPayload) -> String {
        let index = page ?? 0
        return index < quiz.questions.count ? "Question \(index + 1) of \(quiz.questions.count)" : "Result"
    }

    private func binding(for question: QuizQuestion) -> Binding<QuizResponse?> {
        Binding(
            get: { responses[question.id] },
            set: { responses[question.id] = $0 }
        )
    }

    private func finish(_ quiz: QuizPayload) {
        let result = QuizGrader.result(quiz, responses: responses)
        isFinished = true
        OpenSourcebookHaptics.mediumImpact()
        doneTicks.markDone(output, result: result.json)
    }
}

/// One question on one screen.
private struct QuizQuestionView: View {
    let question: QuizQuestion
    let number: Int
    let count: Int
    let showsFeedback: Bool
    @Binding var response: QuizResponse?

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.md) {
                HStack {
                    Text("Question \(number) of \(count)")
                    Spacer()
                    if !question.topic.isEmpty { Text(question.topic).lineLimit(1) }
                }
                .font(OpenSourcebookTheme.Fonts.label)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)

                Text(question.prompt)
                    .font(OpenSourcebookTheme.Fonts.heading)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let display = question.display {
                    MathBlockView(latex: display, caption: nil)
                }

                switch question.body {
                case .choice(let options, let answer, let optionFeedback):
                    choice(options: options, answer: answer, optionFeedback: optionFeedback)
                case .worked(let steps):
                    WorkedStepsView(steps: steps, showsFeedback: showsFeedback, response: $response)
                case .unknown:
                    Text("This kind of question can't be answered in this build. It counts as skipped.")
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                }

                if showsFeedback, let response {
                    let grade = QuizGrader.grade(question, response)
                    if isComplete(response) {
                        FeedbackCard(isRight: grade.fraction == 1,
                                     text: grade.fraction == 1 ? question.feedback.correct : question.feedback.incorrect)
                        // Where the answer comes from, once it can no longer give it away.
                        CiteChips(cites: question.cites)
                    }
                }
            }
            .padding(.horizontal, OpenSourcebookTheme.Spacing.lg)
            .padding(.vertical, OpenSourcebookTheme.Spacing.md)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .vertical)
        .scrollIndicators(.hidden)
    }

    /// A worked question shows its feedback once every step has an answer.
    private func isComplete(_ response: QuizResponse) -> Bool {
        switch (question.body, response) {
        case (.worked(let steps), .worked(let given)):
            return given.count == steps.count && given.allSatisfy { $0.value != nil || $0.revealed }
        default:
            return true
        }
    }

    @ViewBuilder
    private func choice(options: [String], answer: Int, optionFeedback: [String]?) -> some View {
        let picked: Int? = if case .choice(let index)? = response { index } else { nil }
        VStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                OptionButton(text: option, state: optionState(index, picked: picked, answer: answer)) {
                    guard !(showsFeedback && picked != nil) else { return }
                    OpenSourcebookHaptics.lightImpact()
                    response = .choice(index)
                }
            }
        }
        if showsFeedback, let picked, let optionFeedback, optionFeedback.indices.contains(picked) {
            Text(optionFeedback[picked])
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        }
    }

    private func optionState(_ index: Int, picked: Int?, answer: Int) -> OptionButton.State {
        guard let picked else { return .idle }
        if !showsFeedback { return index == picked ? .picked : .idle }
        if index == answer { return .right }
        return index == picked ? .wrong : .idle
    }
}

/// The steps of a worked question; each opens once the one before has an
/// answer. A hint shows after a first wrong try; the answer can be shown,
/// which counts the step as missed.
private struct WorkedStepsView: View {
    let steps: [WorkedStep]
    let showsFeedback: Bool
    @Binding var response: QuizResponse?

    @State private var typed: [Int: [String]] = [:]
    @State private var tries: [Int: Int] = [:]

    private var given: [WorkedStepResponse] {
        if case .worked(let given)? = response { return given }
        return []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.md) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                if index <= given.count {
                    stepView(index, step)
                }
            }
        }
    }

    @ViewBuilder
    private func stepView(_ index: Int, _ step: WorkedStep) -> some View {
        let done = index < given.count
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            Text("Step \(index + 1). \(step.prompt)")
                .font(OpenSourcebookTheme.Fonts.bodySemibold)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
                .fixedSize(horizontal: false, vertical: true)
            switch step.input {
            case .entries(let values):
                ForEach(0..<values.count, id: \.self) { slot in
                    TextField("Answer", text: entry(index, slot, of: values.count))
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .disabled(done)
                }
                if !done {
                    Button("Check") { submit(index, step, .entries(typed[index] ?? Array(repeating: "", count: values.count))) }
                        .buttonStyle(.borderedProminent)
                        .tint(OpenSourcebookTheme.Colors.primary)
                }
            case .choice(let options, let answer):
                let picked: Int? = if done, case .choice(let p)? = given[index].value { p } else { nil }
                ForEach(Array(options.enumerated()), id: \.offset) { option, text in
                    OptionButton(text: text, state: done && showsFeedback
                                 ? (option == answer ? .right : option == picked ? .wrong : .idle)
                                 : (option == picked ? .picked : .idle)) {
                        if !done { submit(index, step, .choice(option)) }
                    }
                }
            }
            if done {
                stepOutcome(index, step)
            } else {
                if let hint = step.hint, tries[index, default: 0] > 0 {
                    Text("Hint: \(hint)")
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.accentText)
                }
                Button("Show the answer") { reveal(index) }
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
        }
    }

    @ViewBuilder
    private func stepOutcome(_ index: Int, _ step: WorkedStep) -> some View {
        let entry = given[index]
        if entry.revealed {
            Text("Answer: \(answerText(step))")
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        } else if showsFeedback, let value = entry.value {
            let right = QuizGrader.isRight(value, for: step)
            Text(right ? "Right" : "Not quite. Answer: \(answerText(step))")
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(right ? OpenSourcebookTheme.Colors.successText : OpenSourcebookTheme.Colors.danger)
        }
    }

    private func answerText(_ step: WorkedStep) -> String {
        switch step.input {
        case .entries(let values): values.joined(separator: ", ")
        case .choice(let options, let answer): options.indices.contains(answer) ? options[answer] : ""
        }
    }

    private func entry(_ step: Int, _ slot: Int, of count: Int) -> Binding<String> {
        Binding(
            get: { typed[step]?[slot] ?? "" },
            set: { value in
                var values = typed[step] ?? Array(repeating: "", count: count)
                values[slot] = value
                typed[step] = values
            }
        )
    }

    /// With feedback after each answer, a wrong first try earns the hint and
    /// another go; after that, or with feedback at the end, the step locks.
    private func submit(_ index: Int, _ step: WorkedStep, _ value: WorkedStepResponse.Value) {
        let right = QuizGrader.isRight(value, for: step)
        if showsFeedback, !right, step.hint != nil, tries[index, default: 0] == 0 {
            tries[index] = 1
            OpenSourcebookHaptics.lightImpact()
            return
        }
        record(index, WorkedStepResponse(value: value))
    }

    private func reveal(_ index: Int) {
        record(index, WorkedStepResponse(value: nil, revealed: true))
    }

    private func record(_ index: Int, _ step: WorkedStepResponse) {
        var list = given
        guard index == list.count else { return }
        list.append(step)
        response = .worked(list)
    }
}

private struct OptionButton: View {
    enum State { case idle, picked, right, wrong }

    let text: String
    let state: State
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(text)
                    .font(OpenSourcebookTheme.Fonts.body)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: OpenSourcebookTheme.Spacing.xs)
                switch state {
                case .right: Image(systemName: "checkmark.circle.fill").foregroundStyle(OpenSourcebookTheme.Colors.success)
                case .wrong: Image(systemName: "xmark.circle.fill").foregroundStyle(OpenSourcebookTheme.Colors.danger)
                case .picked: Image(systemName: "largecircle.fill.circle").foregroundStyle(OpenSourcebookTheme.Colors.primary)
                case .idle: EmptyView()
                }
            }
            .padding(OpenSourcebookTheme.Spacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background)
            .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous)
                .stroke(stroke, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var background: Color {
        switch state {
        case .idle: OpenSourcebookTheme.Colors.surface
        case .picked: OpenSourcebookTheme.Colors.primarySoft
        case .right: OpenSourcebookTheme.Colors.successSoft
        case .wrong: OpenSourcebookTheme.Colors.dangerSoft
        }
    }

    private var stroke: Color {
        switch state {
        case .idle: OpenSourcebookTheme.Colors.border
        case .picked: OpenSourcebookTheme.Colors.primary
        case .right: OpenSourcebookTheme.Colors.success
        case .wrong: OpenSourcebookTheme.Colors.danger
        }
    }
}

private struct FeedbackCard: View {
    let isRight: Bool
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
            Text(isRight ? "Right" : "Not quite")
                .font(OpenSourcebookTheme.Fonts.bodySemibold)
                .foregroundStyle(isRight ? OpenSourcebookTheme.Colors.successText : OpenSourcebookTheme.Colors.danger)
            if !text.isEmpty {
                Text(text)
                    .font(OpenSourcebookTheme.Fonts.body)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(OpenSourcebookTheme.Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isRight ? OpenSourcebookTheme.Colors.successSoft : OpenSourcebookTheme.Colors.dangerSoft)
        .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
    }
}

/// The last sideways page: the score, the pass mark, what to look at again,
/// and the button that finishes the quiz.
private struct QuizResultView: View {
    let result: QuizResult
    let quiz: QuizPayload
    let isFinished: Bool
    let onFinish: () -> Void

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.md) {
                Text("Result")
                    .font(OpenSourcebookTheme.Fonts.label)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                Text("\(Int((result.score * 100).rounded()))%")
                    .font(OpenSourcebookTheme.Fonts.display)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                Text("\(result.correct) of \(result.count) right · pass mark \(Int((quiz.passMark * 100).rounded()))%")
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                if result.answered < result.count {
                    Text("\(result.count - result.answered) not answered yet. Swipe back to answer them.")
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.accentText)
                }
                if !result.topicsMissed.isEmpty {
                    Text("Look again at")
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    ForEach(result.topicsMissed, id: \.self) { topic in
                        Text("· \(topic)")
                            .font(OpenSourcebookTheme.Fonts.body)
                            .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    }
                }
                if isFinished {
                    Label(result.passed ? "Done, passed" : "Done", systemImage: "checkmark.circle.fill")
                        .font(OpenSourcebookTheme.Fonts.bodySemibold)
                        .foregroundStyle(OpenSourcebookTheme.Colors.successText)
                } else {
                    Button(action: onFinish) {
                        Text("Finish quiz")
                            .font(OpenSourcebookTheme.Fonts.bodySemibold)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(OpenSourcebookTheme.Colors.primary)
                    .accessibilityIdentifier("quiz-finish")
                }
            }
            .padding(.horizontal, OpenSourcebookTheme.Spacing.lg)
            .padding(.vertical, OpenSourcebookTheme.Spacing.md)
        }
        .scrollBounceBehavior(.basedOnSize, axes: .vertical)
        .scrollIndicators(.hidden)
    }
}
