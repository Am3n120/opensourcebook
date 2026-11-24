import Foundation

/// Where one item of a plan stands for the person, from the engine's item
/// and the phone's own done tick (DECISIONS.md #27, #28).
enum PlanItemState: Equatable, Sendable {
    /// Ticked: finished or scrolled past, here or on the web.
    case done
    /// Made and waiting to be played.
    case ready
    /// Being made now.
    case making
    /// Not made yet; its turn has not come.
    case waiting
    /// A branch whose condition is not decided yet.
    case behindBranch
    /// An "ask me" branch waiting for the person's answer.
    case asking(question: String?)
    case skipped
    case failed
    case cancelled
    /// Unchecked in the plan: it never runs.
    case off

    /// The words on screen.
    var label: String {
        switch self {
        case .done: "Done"
        case .ready: "Ready"
        case .making: "Being made"
        case .waiting: "Waiting"
        case .behindBranch: "Behind a branch"
        case .asking: "Asks you"
        case .skipped: "Skipped"
        case .failed: "Couldn't be made"
        case .cancelled: "Cancelled"
        case .off: "Off"
        }
    }

    /// Something made that can be opened.
    var isMade: Bool { self == .ready || self == .done }
}

/// One row of a plan on the phone: an item in run order with its branch
/// depth (shown as indentation, DECISIONS.md #19) and its state.
struct PlanRow: Identifiable, Equatable, Sendable {
    let item: StudioItem
    /// How many branch parents above it.
    let depth: Int
    let state: PlanItemState
    /// The stage's label when this row is the first of a labelled stage.
    let stageLabel: String?
    /// True when this row starts a new stage after an earlier one.
    let startsStage: Bool

    var id: String { item.id }
}

/// The plan's items in the order they are meant to be consumed, and what
/// the player plays. Pure, so it is tested apart from the views.
enum PlanLayout {
    /// Items by stage, then position in the stage; ties keep the engine's order.
    static func ordered(_ items: [StudioItem]) -> [StudioItem] {
        items.enumerated()
            .sorted { ($0.element.level, $0.element.ord, $0.offset) < ($1.element.level, $1.element.ord, $1.offset) }
            .map(\.element)
    }

    static func state(of item: StudioItem, isTicked: Bool) -> PlanItemState {
        if !item.enabled { return .off }
        if isTicked || item.done { return .done }
        if item.asking != nil { return .asking(question: item.asking?.question) }
        switch item.status {
        case .done: return item.outputId == nil ? .waiting : .ready
        case .queued, .running: return .making
        case .failed: return .failed
        case .skipped: return .skipped
        case .cancelled: return .cancelled
        case .pending, .unknown: return item.condition == nil ? .waiting : .behindBranch
        }
    }

    /// Rows in run order. `isTicked` is the phone's own tick for an item.
    static func rows(_ view: StudioPlanView, isTicked: (String) -> Bool) -> [PlanRow] {
        let ordered = ordered(view.items)
        let byID = Dictionary(ordered.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let labels = Dictionary(view.stages.compactMap { stage in stage.label.map { (stage.level, $0) } },
                                uniquingKeysWith: { first, _ in first })
        var previousLevel: Int?
        return ordered.map { item in
            var depth = 0
            var parent = item.parentId
            var seen: Set<String> = [item.id]
            while let id = parent, let next = byID[id], seen.insert(id).inserted, depth < 8 {
                depth += 1
                parent = next.parentId
            }
            let isFirstOfLevel = previousLevel != item.level
            defer { previousLevel = item.level }
            return PlanRow(
                item: item,
                depth: depth,
                state: state(of: item, isTicked: isTicked(item.id)),
                stageLabel: isFirstOfLevel ? labels[item.level] : nil,
                startsStage: isFirstOfLevel && previousLevel != nil
            )
        }
    }

    /// The made things to play, in plan order: every row with something
    /// made that the phone holds.
    static func playable(_ rows: [PlanRow], has: (UUID) -> Bool) -> [UUID] {
        rows.compactMap { row in
            guard row.state.isMade, let id = row.item.outputUUID, has(id) else { return nil }
            return id
        }
    }

    /// Where Play starts: the first made thing not done yet, else the first.
    static func start(_ rows: [PlanRow], has: (UUID) -> Bool) -> UUID? {
        let ready = rows.first { $0.state == .ready && ($0.item.outputUUID.map(has) ?? false) }
        return ready?.item.outputUUID ?? playable(rows, has: has).first
    }
}
