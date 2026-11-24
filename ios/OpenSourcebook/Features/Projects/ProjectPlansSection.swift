import SwiftUI

/// Navigation value for one plan.
struct PlanRoute: Hashable {
    let planID: String
}

/// A project's plans, oldest first, as the engine lists them. Plans are made
/// in the chat on the web; the phone opens and plays them (DECISIONS.md #10).
struct ProjectPlansSection: View {
    @EnvironmentObject private var studio: StudioStore
    @EnvironmentObject private var doneTicks: DoneTickStore
    let projectID: String

    var body: some View {
        let key = StudioStore.projectKey(projectID)
        if studio.project(projectID) == nil {
            EmptyStateView(icon: "list.bullet.indent", title: "No plans here",
                           message: "This project is only on this phone. Plans are made in the chat in the web Studio.")
        } else if let plans = studio.plans(inProject: projectID) {
            if plans.isEmpty {
                EmptyStateView(icon: "list.bullet.indent", title: "No plan yet",
                               message: "Plans are made in the chat in the web Studio. None exists for this project yet.")
            } else {
                VStack(spacing: OpenSourcebookTheme.Spacing.sm) {
                    ForEach(plans) { plan in
                        NavigationLink(value: PlanRoute(planID: plan.id)) {
                            PlanSummaryRow(plan: plan, localDone: doneTicks.doneCount(planID: plan.id))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("plan-row-\(plan.id)")
                    }
                }
            }
        } else if let failure = studio.failure(key) {
            ProjectContentStatusView(message: failure) { Task { await studio.refreshProject(projectID) } }
        } else {
            ProjectContentStatusView(message: nil, retry: nil)
        }
    }
}

private struct PlanSummaryRow: View {
    let plan: StudioPlan
    /// Ticks made on this phone that the engine may not have yet.
    let localDone: Int

    private var detail: String {
        var parts = [plan.status.label]
        if let counts = plan.counts, counts.total > 0 {
            parts.append("\(min(counts.total, max(counts.done, localDone))) of \(counts.total) done")
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: OpenSourcebookTheme.Spacing.sm) {
            Image(systemName: "list.bullet.indent")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(OpenSourcebookTheme.Colors.primary)
                .frame(width: 36, height: 36)
                .background(OpenSourcebookTheme.Colors.primarySoft)
                .clipShape(RoundedRectangle(cornerRadius: OpenSourcebookTheme.Radius.r12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(plan.title)
                    .font(OpenSourcebookTheme.Fonts.bodySemibold)
                    .foregroundStyle(OpenSourcebookTheme.Colors.text)
                    .lineLimit(2)
                Text(detail)
                    .font(OpenSourcebookTheme.Fonts.caption)
                    .foregroundStyle(OpenSourcebookTheme.Colors.muted)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(OpenSourcebookTheme.Colors.muted)
        }
        .padding(OpenSourcebookTheme.Spacing.sm)
        .background(OpenSourcebookTheme.Colors.surface)
        .openSourcebookCardStyle()
        .accessibilityElement(children: .combine)
    }
}
