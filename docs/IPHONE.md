# The iPhone app

**The app has not caught up.** It still has the old byte player and no player for flashcards, audio or guides, and it speaks of bytes and bits where the web app now says flashcards and cards. The way to use Open Sourcebook on a phone today is the web app opened by QR code (see [`PHONE.md`](PHONE.md)). The rest of this page describes the app as built.

The iPhone app is in `ios/`: the app in `ios/OpenSourcebook/`, with its share extension in `ios/OpenSourcebookShare/`. It is built with Xcode and is not part of the one-command install: for now you type in the address and token of an engine yourself. The phone page opened by scanning a code from the computer is the web app, not this app, and is not described here.

SwiftUI, SwiftData, no third-party packages. Deployment target iOS 17.0, iPhone and iPad. It is the first app, from August 2026, migrated into the shape `docs/VISION.md` describes: projects as the unit, a project picker instead of a depth picker.

## What it does today

Five controls in a custom bottom bar: four tabs and a raised **+** button that opens capture.

- **Home:** the Inbox, captures still generating, outputs you opened on purpose ("Recently opened"), then projects and the things made on their own (the screen labels them "Projects and things without a project", or "Without a project" with no projects yet), grouped by topic (the `category` field). Projects are the ones made on the phone (you can create and edit those here) and the ones the engine lists from the web Studio; pull to refresh reads the list again.
- **Feed:** bytes and quizzes through the same player shell a plan uses, with the one gesture rule (`docs/DECISIONS.md` #36): scroll down for the next thing and up for the previous, one per screen; swipe sideways through a byte's bits or a quiz's questions. The order comes from a menu (plan order or newest first); a new ordering is one more entry in `OutputOrderings`. Not yet the Feed in `docs/VISION.md`: there is no ranking.
- **+ (Capture):** paste a link or type a note, or attach a file or a photo. Pick where it goes: Auto, an existing project, a new project, or the Inbox. It then goes to the engine as a generation job.
- **Library:** everything made, searchable, in gallery, list or compact layout, with filters (type, tag, favorites, scope), an Archive sheet, and filing into a project.
- **Profile:** engine endpoint and client token with a connection check, a haptics toggle, JSON export of your data, and the app version.

A project opens to three segments: **Items**, **Plans** and **Sources**, read from the engine's Studio routes (`engine/docs/api.md`) through `StudioService` and kept by `StudioStore`. Items lists what was made in the project; one not on the phone yet is fetched when tapped. Plans lists the project's plans; a plan shows its items in run order with labelled stages, branches indented under their parent, and where each one stands: done, ready, being made, waiting, behind a branch, or an "ask me" question with Yes and No. **Play** goes through what is made in plan order under the gesture rule; moving down past a thing ticks it done and a finished quiz sends its result with the tick, so the engine can decide the branches after it. Opening a plan fetches the made things it names that the phone does not hold yet, once, and keeps them like anything else on the phone. The phone reads plans and never edits them (`docs/DECISIONS.md` #10). What was fetched is kept on disk, so it stays readable offline; each screen reads once per launch and again on pull to refresh. An engine without these routes (any before Nov 12, 2026) gets an honest note on Home and nothing else. A project made on the phone has no plans or sources from the Studio. The app knows three shapes, `byte`, `quiz` and `video` (`docs/DECISIONS.md` #33, `ItemShape`), from before flashcards, audio and the guide. It ships them in `FormatCatalog` and refreshes how they look and what they take from the engine's `GET /v1/formats` at launch; which shapes the app plays is fixed, so other ids the engine lists are left out. Stored `bits` and `read` outputs open as bytes and stored `check` outputs as quizzes, through the catalog's aliases; an id the app has never seen still decodes and shows a neutral badge. Each shape has a player (`PlayerRegistry`):

- **Byte** (`BytePlayerView`): its bits side by side, one screen each, with a position indicator; it remembers the bit you were on. Under a bit, one quiet chip per source it cites names the source and, when the cites share one, the page, slide, moment or cell. Tapping a chip shows each cited spot: the passage from the source's text with the quoted words marked, a harvested picture for an image or graph, the time for a moment; a kind of spot the app doesn't know is shown as a passage. A quiz question's chips appear once it is answered. A byte from the engine carries its bits; an old stored page is cut into bits on the phone the way the engine upgrades it (`ByteCutter`: at headings and kickers, within the 900-unit budget, long text split at paragraph then sentence ends, page layout blocks dropped, nothing else lost). A bit or block the app can't draw says so.
- **Quiz** (`QuizPlayerView`): questions sideways (choice and worked, step by step with a hint after a first wrong try), feedback after each answer or at the end as the quiz says, then the score. Finishing sends the result with the item's done tick, graded the way the engine grades it.
- **Video** (`VideoPlayerView`): fills the screen, nothing sideways. It plays the video file the engine serves for an item, or says it cannot play it.

Moving down past a plan item, or finishing a quiz, ticks the item done; ticks are kept on the phone and sent to the engine. The share extension ("Save to Open Sourcebook") takes URLs, text, images, files and audio from other apps and lets you pick the destination.

## Layout of the iOS code

| Folder | What |
|---|---|
| `ios/OpenSourcebook/App` | App entry, root tab bar, launch environment (test mode). |
| `ios/OpenSourcebook/State` | `OutputStore` (outputs, projects, capture jobs on SwiftData), `StudioStore` (the Studio's projects, plans, made things and sources as last fetched, kept on disk), `DoneTickStore`, `AppState` (tabs, sheets, player), share-inbox bridge. |
| `ios/OpenSourcebook/Models` | `Output`, `Bit` and `ByteCutter`, `Quiz`, `Block`, `ItemShape`, the format catalog, `Project`, the Studio shapes from `engine/docs/api.md` (`StudioProject`, `StudioPlanView`, `StudioItem`, `StudioOutput`) and how a plan is laid out and played (`PlanLayout`), citations (`Cite`, `CiteGroup`, `CiteExcerpt`), source kinds, SwiftData records. |
| `ios/OpenSourcebook/Player` | Player shell (the vertical pager and the gesture rule, `PlayerPaging`), play queue, ordering protocol and its two orderings, registry of which shape has which player. |
| `ios/OpenSourcebook/Features` | Screens: `Home`, `Feed`, `Library`, `Profile`, `Capture`, `Inbox`, `Projects`. |
| `ios/OpenSourcebook/Engine` | Engine configuration, generation and upload clients, asset URL resolver, done-tick sync, the Studio client (`StudioClient` protocol, `StudioService` over HTTP, `RecordedStudio` for tests). |
| `ios/OpenSourcebook/Renderer` | The byte, quiz and video players, and the block views a bit is made of (text, charts, media, interactive blocks and more). |
| `ios/OpenSourcebook/DesignSystem` | Theme tokens (light only), haptics, shared components. |
| `ios/OpenSourcebookShare` | The share extension. |
| `ios/Shared` | Code compiled into both the app and the extension: inbox, source parsing, project picker. |
| `ios/Config` | xcconfig files and the partial `OpenSourcebook-Info.plist`. |

## Build and run

- **Requirements:** a Mac with Xcode 26 or later (the project file was last upgraded with Xcode 26.2). iOS 17.0 or later on the simulator or device.
- Open `ios/OpenSourcebook.xcodeproj`, choose the `OpenSourcebook` scheme, and run. All build settings live in `ios/Config/*.xcconfig`, not in the project file.
- **Signing:** `ios/Config/Base.xcconfig` sets the bundle id prefix and the app group, with automatic signing, and leaves the development team empty. To run on your own device, copy `ios/Config/Local.xcconfig.example` to `ios/Config/Local.xcconfig` (git-ignored) and set `DEVELOPMENT_TEAM`, `OPENSOURCEBOOK_BUNDLE_ID_PREFIX` and `OPENSOURCEBOOK_APP_GROUP` there. `Base.xcconfig` includes `Local.xcconfig` last, so anything set in it overrides the defaults, for the app, the share extension and the tests. Change the bundle id prefix and the app group together, since the app, the extension and the tests derive their ids from them.
- **Engine URL and token:** a fresh build has no engine configured and generation is disabled. Either enter the endpoint and token in Profile, or set `ENGINE_BASE_URL` and `ENGINE_CLIENT_TOKEN` in `ios/Config/Local.xcconfig`; they reach the app as the `EngineBaseURL` and `EngineClientToken` keys of `ios/Config/OpenSourcebook-Info.plist`. Values saved in Profile take precedence. The example file shows the `$()` trick that stops xcconfig reading `https://` as a comment. The engine is in `engine/`; see its README to run it locally.
- **App group and share extension:** the app and `OpenSourcebookShare` share an app group (`OPENSOURCEBOOK_APP_GROUP`, from `ios/Config/Base.xcconfig`, in both entitlements files). The extension writes what you share into the group container; the app drains it on launch and when it returns to the foreground. Signing both targets needs a team that can register the app group.

## Tests

Both targets are in the `OpenSourcebook` scheme's test action.

- **`OpenSourcebookTests`** (unit, hosted by the app, in-memory stores only): the Studio client (routes, paging, errors, decoding the doc's examples and real outputs from a local run in `ios/OpenSourcebookTests/Fixtures`), plan layout and item states, the Studio store (offline copy, an engine without the routes, fetching a plan's made things once, ticks and quiz results, "ask me" answers), citations (grouping, places, the cited passage found in the source text), decoding of the engine's wire format and the app's own, unknown-block fallback, the format catalog and old ids, cutting old pages into bits, the paging rule, quiz decoding and grading, done ticks with results, plan ordering and the two feed orderings, Library filters, `OutputStore` (filing, favorites, archive, projects, capture jobs, reload through SwiftData), capture source parsing, the share inbox, and engine configuration.
- **`OpenSourcebookUITests`:** the tab bar and capture sheet, creating a project and opening its Items, Plans and Sources segments, a plan from a faked Studio (`OPENSOURCEBOOK_TEST_STUDIO`) played through a byte and a quiz with a citation opened and both items ticked, empty Library and Feed, the Profile engine section, and the gesture rule with real swipes (an old page and a byte in the Feed, sideways through bits, down to the next item, a quiz answered and finished). The app starts with `-uiTesting`, which uses an in-memory store and no engine; a UI test can hand it items to play as JSON in `OPENSOURCEBOOK_TEST_OUTPUTS`.

Run with Cmd-U in Xcode, or from a terminal on a simulator (no signing needed):

```bash
xcodebuild test -project ios/OpenSourcebook.xcodeproj -scheme OpenSourcebook -destination 'platform=iOS Simulator,name=iPhone 17'
```

Status, Nov 13, 2026, on an iPhone 17 simulator (iOS 27.2, Xcode 27.2): `OpenSourcebookTests` 204 tests, 0 failures; `OpenSourcebookUITests` 9 tests, 0 failures. (Earlier, `OpenSourcebookTests` ran on a physical iPhone 15 Pro with 113 tests and 0 failures; the UI test runner could not be signed there.)

## Status

- **In:** everything above: tabs, projects, the Inbox, the project picker, the player shell with a swappable ordering, the byte, quiz and video players under one gesture rule, and the tests.
- **Not yet:** projects made on the phone are not created on the engine, so they have no plans or sources from the web app; topics (the `category` field exists and nothing fills it); a ranked feed. The video player has not been checked here against a video made by the scenes service.
