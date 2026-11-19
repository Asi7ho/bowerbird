# Bowerbird on macOS — Swift/SwiftUI app, Python plugins

Branch `macos/swift`, started 2026-11-19. The Electron app stays the
shipping line until this one reaches parity; nothing here is a PR
until the user says so.

## Why

The user decided 2026-11-18: creatives are mostly on macOS, so
testing and distribution are one platform, and there is one platform
to optimise for. The app becomes a proper Mac app (Swift/SwiftUI)
and the plugins become Python. This is the plan for getting there
without losing anything the Electron version does.

## Ground rules

- **1:1 functionality and style.** Every feature the Electron app
  has, the Swift app has, behaving the same way. Every surface
  looks the same: the same cards, toolbar, title bar, panels and
  spacing, measured against the Electron app side by side (M8).
- **board.json is the contract.** The Swift app reads and writes
  the exact same board format (`BOWERBIRD_SPEC.md`): same fields,
  same kind tags, same ids. A board made in the Electron app opens
  in the Swift app and back again, with no migration and no loss.
  The data directory layout stays the same too
  (`~/Library/Application Support` replaces the XDG data dir on
  macOS; the board folder structure inside it is identical).
- **Small commits, one logical change each**, so any step can be
  reviewed, reverted or fixed on its own. A milestone lands only
  when its done-criteria pass.
- **No PR until the user asks.** Work stays on this branch.
- **Verification I can actually do.** This machine is Linux with
  no Swift toolchain and no Xcode, so I cannot build or run the
  Mac app here. Verification is: `swift build` + `swift test` on
  GitHub's macOS runners (the `swift.yml` workflow, which runs on
  every push to this branch), plus the user's Mac for the visual
  and feel checks — the same loop as the Electron app, where the
  user runs from source. Nothing is called done from a code read
  alone.

## Architecture sketch

- **App shell:** SwiftUI `App` + `WindowGroup`. AppKit where
  SwiftUI cannot do the job (window chrome, drag regions, file
  watching, global shortcuts). One window, like the Electron app.
- **Board canvas:** the scaling problem is a DOM problem in the
  Electron app (2,000 cards, software compositing). The Swift
  canvas must not repeat it by making 2,000 SwiftUI views. The
  leading design (decide in M2, measure before committing): one
  `Canvas` (or a Metal-backed layer) that draws cards as vector
  content, with SwiftUI views only for the card being edited.
  Measure pan/select at 2,000 cards before choosing.
- **Data:** Swift `Codable` types mirroring `board.json`
  (`swift/Sources/BowerbirdCore/Model.swift`). All board mutation
  goes through one store (undo, save, recovery journal, backups),
  like `src/backend/undo.ts` and `electron/backups.ts`.
- **Importers:** port the TypeScript parsers, not new ones. SVG
  (hand-written parser, exploded editable cards), PSD (layer +
  composite reader), AI (PDF-based), PDF (PDFKit), images
  (CoreImage/AppKit), audio/video (AVFoundation), GLB (M5
  decision: SceneKit vs a custom loader — SceneKit does not
  read GLB natively, so this is a real scope risk; decide
  early, do not leave it to M5).
- **Live sync:** FSEvents on the board's `assets/` (the Electron
  app uses `fs.watch`); same semantics (debounce, ignore own
  writes, re-import in place).
- **Search:** port the MiniSearch-style text index; the context
  index stays a background job.
- **Voice notes:** Whisper on-device. Route to decide in M5:
  Apple's Speech framework vs whisper.cpp via a Swift wrapper.
  The model files stay bundled the same way (`models/`).
- **Python plugins (M7):** the plugin API mirrors the
  TypeScript `PluginContext` (same capabilities, same
  isolation: a plugin runs only its own commands/shortcuts/
  cards). Host mechanism is the big open decision — embedded
  CPython (PythonKit) vs a plugin helper process speaking
  JSON-RPC over a socket. Decide in M0/M7 with a spike, not
  by argument: the spike must prove a Python plugin can
  render a card and run a command. The six core plugins
  (board, toolbar, cards, search, settings, titlebar) become
  Python, like the Electron core plugins are JS.
- **Packaging (M9):** a real `.app` in a DMG, signed and
  notarised with the user's Apple Developer ID; auto-update
  is a user decision, not assumed.

## Milestones

### M0 — Branch, plan, skeleton (this turn)

- [x] Branch `macos/swift` from `main`, own worktree.
- [x] This plan.
- [ ] Swift package skeleton (`swift/`): `Package.swift`, an
  app entry that opens an empty window, the board model
  (`Model.swift`) with a decoding test, and the macOS CI
  workflow (`swift.yml`: `swift build` + `swift test` on a
  macOS runner, on push to this branch).
- Done: CI green on the branch.

### M1 — Board data + persistence

- Load/save `board.json` (same format, round-trip identical),
  `healDuplicateIds`, the recovery journal
  (`recovery.json`), hourly backups (newest 10), named boards,
  settings + plugin state storage, save on quit.
- Done: the Swift app opens the user's real board from the
  Electron data dir and saves it back with no loss; a crash
  mid-edit offers recovery, like the Electron app.

### M2 — Canvas + camera

- Infinite canvas, pan (Space+drag, trackpad), wheel/trackpad
  zoom, zoom-to-fit, grid (Dots/Lines/None), background
  colour. Card rendering for every kind, visible-set culling,
  selection (click, Shift-add, marquee, lasso), selection
  stacking (selected to front, visually only), groups with
  frames + labels, selected-group frame above cards.
- Done: the welcome board renders and reads like the
  Electron version at the same zoom; pan/zoom/fit feel the
  same; 2,000-card board measured (the M2 canvas decision
  is made on this measurement).

### M3 — Editing + drawing tools

- Text notes (create, edit, auto-grow, note colour bar),
  move/resize/rotate, group/ungroup, delete, undo/redo.
  Pencil (graphite texture, live and committed), pen,
  highlighter, eraser (splits strokes), shapes
  (fill/outline), connectors, arrow colour rule (toolbar
  arrow stays black, drawn arrow takes the pen colour).
  Toolbar + pickers (transient flyouts), shortcuts (V/P/R/A/X,
  F fit, Ctrl+K palette, Ctrl+G/U, Escape deselect).
- Done: a full draw/edit session works end to end; undo/redo
  parity with the Electron app.

### M4 — Importers + live sync

- Drop/paste: image, PDF, audio, video, GLB, SVG (exploded
  editable cards), PSD/AI (single FileCard, preview, opens in
  its editor on double-click). Live sync: external edits
  re-import in place, missing source keeps its link, delete
  unlinks with a toast. Link previews for URL cards.
- Done: dropping the welcome-bird SVG explodes into the same
  32 items; editing a PSD on disk re-imports it in place.

### M5 — Media, 3D, voice

- Audio playback + seek + transcript toggle, voice-note
  recording + on-device transcription. Video poster-first
  cards, play on click. PDF page rendering + prev/next.
  Model3D: GLB loads, drag rotates, wheel zooms, idle
  auto-rotate, fit button (opening view), on-demand render
  (not a frame loop at rest).
- Done: every media card plays/renders like the Electron
  version; the 3D decision (M0) is implemented, not deferred.

### M6 — Search, palette, boards, settings, export

- Search box (text + context index, jump to match), routing
  command palette, Settings (incl. Data export/import),
  Boards panel + Versions, full-install export/import ZIP
  (boards, plugins, state) that round-trips with the Electron
  app.
- Done: an Electron export imports into the Swift app and
  back; search and palette behave the same.

### M7 — Python plugin system

- Host spike + decision (embedded CPython vs helper
  process), plugin manifest + lifecycle, enable/disable,
  isolation (a plugin runs only its own commands/shortcuts/
  cards), plugin API mirroring `PluginContext`, plugin
  storage + secure storage, install from a folder/ZIP.
  The six core plugins ported to Python.
- Done: a sample Python plugin renders a card and runs a
  command; the core plugins run as Python; a disabled
  plugin's cards show the placeholder and keep their data.

### M8 — Polish + parity audit

- Style tokens 1:1: measure every surface against the
  Electron app (card chrome, toolbar, title bar, panels,
  dialogs, toasts) and fix the diffs. Performance at scale
  (2,000 cards: pan, select, fit). Keyboard shortcuts and
  accessibility pass. Buyer-polish pass (icon, DMG open
  path, file names, listing copy) where it applies.
- Done: the parity checklist (below) is all green.

### M9 — Release

- Real `.app` in a DMG, signed + notarised, first Swift
  release (version to be decided — the Electron line is at
  v0.1.4). The Electron line is retired only by the user's
  decision, not by this milestone landing.
- Done: a clean-machine install opens the welcome board.

## Parity checklist (M8 — the 1:1 proof)

The checklist is the Electron app's own behaviour, taken from
`BOWERBIRD_SPEC.md`, `ARCHITECTURE.md`, `PLUGIN_API.md` and
the e2e suite (`tests/e2e/run.mjs`, 56 checks). Each line is
one check, run against both apps on the same board:

- Board loads, saves, recovers, backs up; undo/redo.
- Every card kind renders, selects, moves, resizes, rotates,
  deletes; groups frame and label; selection stacking.
- Every tool + shortcut; pencil texture live and committed.
- Every importer + live sync; link previews.
- Search, palette, settings, boards, versions, export/import.
- Media playback, transcription, PDF pages, 3D rotate/zoom/
  auto-rotate/fit.
- Plugin install/enable/disable, isolation, placeholder.
- Style: card chrome, toolbar, title bar, panels, dialogs —
  measured, not eyeballed.

## Open decisions (do not guess — spike or ask)

1. Canvas tech (M2): SwiftUI `Canvas` vs AppKit `NSView` vs
   Metal. Decide on the 2,000-card measurement.
2. GLB loading (M5): SceneKit vs custom loader vs converting
   at import. Decide early — it can change M4/M5 scope.
3. Python host (M7): embedded CPython vs helper process.
   Spike first.
4. Whisper route (M5): Speech framework vs whisper.cpp.
5. Packaging + auto-update (M9): signing needs the user's
   Apple Developer ID; auto-update is the user's call.
6. What "macOS-only" does to the Electron line: it keeps
   shipping until the Swift line reaches parity (M8), then
   the user decides.
