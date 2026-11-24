import SwiftUI

/// One plan: its items in the order they are meant to be consumed, each with
/// where it stands (done, ready, being made, waiting, behind a branch), and
/// Play, which goes through what is made with the one gesture rule
/// (DECISIONS.md #36). Moving down past a thing ticks it done; a quiz's
/// result goes with its tick, so the plan's branches can move. Branches are
/// indented (#19). The phone reads the plan; it doesn't edit it (#10).
struct PlanView: View {
    @EnvironmentObject private var studio: StudioStore
    @EnvironmentObject private var store: OutputStore
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var doneTicks: DoneTickStore
    let planID: String

    /// True while the player shows this plan, so closing it reads the plan again.
    @State private var isPlaying = false
    @State private var answering: String?

    var body: some View {
        let key = StudioStore.planKey(planID)
        Group {
            if let view = studio.planView(planID) {
                content(view)
            } else if let failure = studio.failure(key) {
                ProjectContentStatusView(message: failure) { Task { await studio.refreshPlan(planID) } }
            } else {
                ProjectContentStatusView(message: nil, retry: nil)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(OpenSourcebookTheme.Colors.background)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: planID) {
            await studio.readOnce(key) { await studio.refreshPlan(planID) }
        }
        .onChange(of: appState.isPlayerPresented) { _, presented in
            guard !presented, isPlaying else { return }
            isPlaying = false
            Task {
                // Ticks first, so the plan read back already has them and its branches moved.
                await doneTicks.flush()
                await studio.refreshPlan(planID)
            }
        }
    }

    private func content(_ view: StudioPlanView) -> some View {
        let rows = PlanLayout.rows(view) { doneTicks.isDone(planID: planID, itemID: $0) }
        let has: (UUID) -> Bool = { store.output(forID: $0) != nil }
        let playable = PlanLayout.playable(rows, has: has)
        let failure = studio.failure(StudioStore.planKey(planID))
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.sm) {
                header(view, rows: rows)
                if let failure {
                    Text(failure)
                        .font(OpenSourcebookTheme.Fonts.caption)
                        .foregroundStyle(OpenSourcebookTheme.Colors.accentText)
                }
                playButton(start: PlanLayout.start(rows, has: has), queue: playable)
                    .padding(.bottom, OpenSourcebookTheme.Spacing.xs)
                ForEach(rows) { row in
                    if row.startsStage || row.stageLabel != nil {
                        stageHeader(row.stageLabel)
                    }
                    PlanItemRowView(row: row, isHeld: row.item.outputUUID.map(has) ?? false,
                                    isAnswering: answering == row.id,
                                    open: { open(row, queue: playable) },
                                    answer: { answer(row, $0) })
                        .padding(.leading, CGFloat(row.depth) * OpenSourcebookTheme.Spacing.lg)
                }
            }
            .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
            .padding(.bottom, OpenSourcebookTheme.Spacing.xl)
        }
        .refreshable { await studio.refreshPlan(planID) }
    }

    private func header(_ view: StudioPlanView, rows: [PlanRow]) -> some View {
        let counted = rows.filter { $0.state != .off && $0.state != .skipped }
        let done = counted.filter { $0.state == .done }.count
        var detail = [view.plan.status.label]
        if !counted.isEmpty { detail.append("\(done) of \(counted.count) done") }
        return VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xxs) {
            Text(view.plan.title)
                .font(OpenSourcebookTheme.Fonts.title)
                .tracking(OpenSourcebookTheme.Fonts.tightTracking)
                .foregroundStyle(OpenSourcebookTheme.Colors.text)
            Text(detail.joined(separator: " · "))
                .font(OpenSourcebookTheme.Fonts.caption)
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
                .accessibilityIdentifier("plan-progress")
            if view.plan.status.isBeforeStart {
                Text("This plan hasn't started. Start it in the web Studio.")
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
        }
        .padding(.top, OpenSourcebookTheme.Spacing.xs)
    }

    private func playButton(start: UUID?, queue: [UUID]) -> some View {
        Button {
            guard let start, let output = store.output(forID: start) else { return }
            OpenSourcebookHaptics.lightImpact()
            isPlaying = true
            appState.present(output, in: PlayerQueue(outputIDs: queue))
        } label: {
            Label(queue.isEmpty ? "Nothing made yet" : "Play", systemImage: "play.fill")
                .font(OpenSourcebookTheme.Fonts.bodySemibold)
                .foregroundStyle(queue.isEmpty ? OpenSourcebookTheme.Colors.muted : .white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, OpenSourcebookTheme.Spacing.sm)
                .background(queue.isEmpty ? OpenSourcebookTheme.Colors.fill : OpenSourcebookTheme.Colors.primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(start == nil)
        .accessibilityIdentifier("plan-play")
    }

    private func stageHeader(_ label: String?) -> some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
            if let label {
                Text(label)
                    .font(OpenSourcebookTheme.Fonts.label)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
            Rectangle().fill(OpenSourcebookTheme.Colors.border).frame(height: 1)
        }
        .padding(.top, OpenSourcebookTheme.Spacing.xs)
    }

    private func open(_ row: PlanRow, queue: [UUID]) {
        guard row.state.isMade, let id = row.item.outputUUID, let output = store.output(forID: id),
              PlayerRegistry.standard.canPlay(output.type) else { return }
        OpenSourcebookHaptics.lightImpact()
        isPlaying = true
        appState.present(output, in: PlayerQueue(outputIDs: queue))
    }

    private func answer(_ row: PlanRow, _ yes: Bool) {
        answering = row.id
        Task {
            _ = await studio.answer(planID: planID, itemID: row.id, answer: yes)
            answering = nil
        }
    }
}

/// One item: its format, title and where it stands; an "ask me" branch asks
/// its question with Yes and No.
private struct PlanItemRowView: View {
    let row: PlanRow
    /// The made thing is on this phone.
    let isHeld: Bool
    let isAnswering: Bool
    let open: () -> Void
    let answer: (Bool) -> Void

    private var stateColor: Color {
        switch row.state {
        case .done: OpenSourcebookTheme.Colors.successText
        case .ready, .making, .asking: OpenSourcebookTheme.Colors.primaryText
        case .failed: OpenSourcebookTheme.Colors.accentText
        default: OpenSourcebookTheme.Colors.muted
        }
    }

    private var stateText: String {
        if row.state.isMade && !isHeld { return "\(row.state.label) · not on this phone yet" }
        return row.state.label
    }

    var body: some View {
        VStack(alignment: .leading, spacing: OpenSourcebookTheme.Spacing.xs) {
            Button(action: open) {
                HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                    TypeBadge(row.item.type)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.item.title)
                            .font(OpenSourcebookTheme.Fonts.bodySemibold)
                            .foregroundStyle(row.state == .off || row.state == .skipped ? OpenSourcebookTheme.Colors.muted : OpenSourcebookTheme.Colors.text)
                            .lineLimit(2)
                        Text(stateText)
                            .font(OpenSourcebookTheme.Fonts.caption)
                            .foregroundStyle(stateColor)
                            .accessibilityIdentifier("plan-item-state-\(row.id)")
                    }
                    Spacer(minLength: 0)
                    if row.state == .done {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(OpenSourcebookTheme.Colors.successText)
                            .accessibilityLabel("Done")
                    } else if row.state == .making {
                        ProgressView().controlSize(.small)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!(row.state.isMade && isHeld))

            if case .asking(let question) = row.state {
                Text(question ?? "Do you want this one?")
                    .font(OpenSourcebookTheme.Fonts.body)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                HStack(spacing: OpenSourcebookTheme.Spacing.xs) {
                    answerButton("Yes", yes: true)
                    answerButton("No", yes: false)
                    if isAnswering { ProgressView().controlSize(.small) }
                }
            }
        }
        .padding(OpenSourcebookTheme.Spacing.sm)
        .background(OpenSourcebookTheme.Colors.surface)
        .openSourcebookCardStyle()
        .accessibilityIdentifier("plan-item-\(row.id)")
    }

    private func answerButton(_ title: String, yes: Bool) -> some View {
        Button(title) { answer(yes) }
            .font(OpenSourcebookTheme.Fonts.bodySemibold)
            .padding(.horizontal, OpenSourcebookTheme.Spacing.md)
            .padding(.vertical, OpenSourcebookTheme.Spacing.xs)
            .background(yes ? OpenSourcebookTheme.Colors.primary : OpenSourcebookTheme.Colors.fill)
            .foregroundStyle(yes ? Color.white : OpenSourcebookTheme.Colors.text)
            .clipShape(Capsule())
            .buttonStyle(.plain)
            .disabled(isAnswering)
    }
}
