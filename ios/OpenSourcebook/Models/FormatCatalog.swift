import Foundation
import Observation

/// Every format this build knows, in the engine's registration order, with
/// lookup by id or alias. A value: tests and pure logic take one directly;
/// views read the live one from `FormatRegistry.shared`.
struct FormatCatalog: Equatable, Sendable {
    let formats: [FormatDescriptor]
    /// Id and alias to position in `formats`. First entry wins on a clash.
    private let index: [FormatID: Int]

    init(formats: [FormatDescriptor]) {
        var kept: [FormatDescriptor] = []
        var index: [FormatID: Int] = [:]
        for descriptor in formats where index[descriptor.id] == nil {
            let position = kept.count
            kept.append(descriptor)
            index[descriptor.id] = position
            for alias in descriptor.aliases where index[alias] == nil {
                index[alias] = position
            }
        }
        self.formats = kept
        self.index = index
    }

    /// The descriptor for an id or an old alias; nil for a format this
    /// catalog doesn't know (it is shown with a neutral badge).
    func descriptor(for id: FormatID) -> FormatDescriptor? {
        index[id].map { formats[$0] }
    }

    /// The current id for `id`: an alias maps to its format, an unknown id
    /// stays as it is.
    func canonicalID(for id: FormatID) -> FormatID {
        descriptor(for: id)?.id ?? id
    }

    /// Registration position, for sorting; unknown ids have none.
    func position(of id: FormatID) -> Int? {
        index[id]
    }

    /// `ids` with aliases folded in and duplicates dropped, known formats in
    /// registration order first, then unknown ones by name.
    func ordered(_ ids: some Sequence<FormatID>) -> [FormatID] {
        let unique = Set(ids.map(canonicalID(for:)))
        return unique.sorted { lhs, rhs in
            switch (position(of: lhs), position(of: rhs)) {
            case let (l?, r?): return l < r
            case (.some, nil): return true
            case (nil, .some): return false
            case (nil, nil): return lhs.rawValue < rhs.rawValue
            }
        }
    }
}

extension FormatCatalog {
    /// The `GET /v1/formats` body: `{ formats: [descriptor] }`. Descriptors
    /// that don't decode are skipped; a body with none is an error, so a bad
    /// response never empties the catalog.
    static func decode(_ data: Data) throws -> FormatCatalog {
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        guard !envelope.formats.elements.isEmpty else { throw EmptyCatalog() }
        return FormatCatalog(formats: envelope.formats.elements)
    }

    struct EmptyCatalog: Error {}

    private struct Envelope: Decodable {
        let formats: LossyList<FormatDescriptor>
    }

    /// What ships in the app, used until the engine answers and whenever it
    /// can't be reached: the three shapes Open Sourcebook makes (DECISIONS.md #33), each
    /// with the old ids stored rows may carry. Byte takes the retired bits
    /// and read ids (#34), quiz the retired check id (#35).
    static let bundled: FormatCatalog = {
        do {
            return try decode(Data(bundledJSON.utf8))
        } catch {
            preconditionFailure("Bundled formats don't decode: \(error)")
        }
    }()

    private static let bundledJSON = """
    {
      "formats": [
        {
          "id": "byte", "label": "byte", "colorSlot": 2, "icon": "feed",
          "aliases": ["bits", "read"],
          "settings": [
            { "key": "depth", "label": "Depth", "kind": "choice",
              "help": "How much the byte covers. Auto picks from the size of the sources.",
              "options": [
                { "value": "saveOnly", "label": "Save only" },
                { "value": "light", "label": "Light" },
                { "value": "standard", "label": "Standard" },
                { "value": "deep", "label": "Deep" },
                { "value": "auto", "label": "Auto" }
              ] },
            { "key": "exemplarSummaries", "label": "Style examples", "kind": "textList",
              "help": "Earlier summaries the writing should sound like.",
              "maxItems": 12, "maxLength": 4000, "hidden": true }
          ],
          "defaults": { "depth": "auto", "exemplarSummaries": [] },
          "ready": true
        },
        { "id": "quiz", "label": "quiz", "colorSlot": 3, "icon": "check",
          "aliases": ["check"], "settings": [], "defaults": {}, "ready": true },
        { "id": "video", "label": "video", "colorSlot": 1, "icon": "play",
          "settings": [], "defaults": {}, "ready": false }
      ]
    }
    """

    /// The shapes are fixed (DECISIONS.md #37: makers are open, shapes are
    /// not), so the engine's answer only refreshes what it says about them:
    /// its descriptor for a shape replaces the bundled one, keeping every
    /// old id either knew; a shape it doesn't list keeps the bundled entry,
    /// readiness taken from whichever old id the engine still lists. Ids that
    /// are not one of the shapes are left out, so an engine still on the old
    /// format set never puts retired words on screen.
    func shaped(by engine: FormatCatalog) -> FormatCatalog {
        FormatCatalog(formats: formats.map { shape in
            let known = Set([shape.id] + shape.aliases)
            if let fresh = engine.formats.first(where: { $0.id == shape.id }) {
                let aliases = (shape.aliases + fresh.aliases).reduce(into: [FormatID]()) { list, id in
                    if !list.contains(id) && id != shape.id { list.append(id) }
                }
                return fresh.with(aliases: aliases)
            }
            if let old = engine.formats.first(where: { known.contains($0.id) || !known.isDisjoint(with: $0.aliases) }) {
                return shape.with(isReady: old.isReady)
            }
            return shape
        })
    }
}

extension FormatDescriptor {
    func with(aliases: [FormatID]? = nil, isReady: Bool? = nil) -> FormatDescriptor {
        FormatDescriptor(id: id, label: label, colorSlot: colorSlot, icon: icon,
                         aliases: aliases ?? self.aliases, settings: settings,
                         defaults: defaults, isReady: isReady ?? self.isReady)
    }
}

/// The live catalog: starts as the bundled one, replaced when the engine's
/// `GET /v1/formats` answers. Observable, so badges and filters redraw when
/// it changes; readable from any thread.
@Observable
final class FormatRegistry: @unchecked Sendable {
    static let shared = FormatRegistry()

    @ObservationIgnored private let lock = NSLock()
    @ObservationIgnored private var storage: FormatCatalog

    init(catalog: FormatCatalog = .bundled) {
        storage = catalog
    }

    var catalog: FormatCatalog {
        get {
            access(keyPath: \.catalog)
            return lock.withLock { storage }
        }
        set {
            guard newValue != lock.withLock({ storage }) else { return }
            withMutation(keyPath: \.catalog) {
                lock.withLock { storage = newValue }
            }
        }
    }
}

extension FormatID {
    /// What the live catalog says about this id; nil when it doesn't know it.
    var descriptor: FormatDescriptor? {
        FormatRegistry.shared.catalog.descriptor(for: self)
    }
}
