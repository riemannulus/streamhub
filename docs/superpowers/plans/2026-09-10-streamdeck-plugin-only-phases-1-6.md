# Stream Deck Plugin-Only Phases 1–6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the production plugin-only Streamhub path through Studio UX, including measured playback, `StudioDocument v2`, full-LCD rendering, unlock animations, an authenticated Runtime gateway, a production Stream Deck plugin, and canvas-first Studio controls.

**Architecture:** `Streamhub Runtime` owns signals, page selection, safe action execution, rendering, and compiled transitions. A thin Stream Deck plugin connects over an authenticated loopback WebSocket, applies opaque key frames, caches the latest resume package, and forwards coordinate events. Studio edits a server-owned v2 document and applies it to the running Runtime; neither Studio nor Runtime opens HID hardware.

**Tech Stack:** Bun 1.4, TypeScript 5.9, Bun SQLite/HTTP/WebSocket, Sharp 0.34, `@elgato/streamdeck`, HTML/CSS browser UI.

**Spec:** `docs/superpowers/specs/2026-09-10-streamdeck-plugin-only-architecture-design.md`

## Global Constraints

- Product device support is one 5×3 Stream Deck Classic/MK.2-class device with 72×72 LCD keys.
- Full-LCD geometry is 480×272 with key origins x=`11,108,205,302,399`, y=`5,102,199`.
- Stream Deck App is the sole physical device owner; new production code must not import `@elgato-stream-deck/node`.
- Existing authentication tokens, sources, collectors, actions, and signal database remain valid; existing `streamdeck.board` and view layout are not migrated.
- Dynamic signal records cannot supply executable paths. Only existing validated action/open effects may execute.
- `setImage` completion means request sent, not hardware displayed; metrics and protocol names must use `sent`.
- Every production behavior is added test-first and each task ends with a focused commit.
- Direct HID files remain until the joint phase-7 hardware acceptance; they are not used by the new path.

---

### Task 1: Playback Metrics and Deadline Scheduler

**Files:**
- Create: `packages/presentation/metrics.ts`
- Create: `packages/presentation/metrics.test.ts`
- Create: `packages/presentation/playback.ts`
- Create: `packages/presentation/playback.test.ts`

**Interfaces:**
- Produces: `PlaybackMetric`, `PlaybackRecorder`, `FramePlan`, `playFramePlan(plan, sink, options)`.
- `FramePlan.frames` contains opaque 15-key data URI arrays and absolute offsets from playback start.
- Later plugin code supplies a sink that calls 15 `setImage` operations concurrently.

- [x] **Step 1: Write failing metric tests**

```ts
test('recorder separates external warmup from Streamhub restore', () => {
  const recorder = new PlaybackRecorder(() => 1000);
  recorder.mark('warming');
  recorder.mark('cells-ready', 4100);
  recorder.mark('first-frame-sent', 4180);
  recorder.mark('final-frame-sent', 4550);
  expect(recorder.summary()).toEqual({warmupMs:3100,startMs:80,playbackMs:370,totalStreamhubMs:450});
});
```

- [x] **Step 2: Run `bun test packages/presentation/metrics.test.ts` and confirm failure because the module does not exist**
- [x] **Step 3: Implement a bounded recorder that accepts only known ordered marks and returns millisecond summaries without logging tokens or payloads**
- [x] **Step 4: Run the focused test and confirm it passes**
- [x] **Step 5: Write failing playback tests for concurrent cell dispatch, skipped late intermediate frames, guaranteed final frame, and cancellation by a newer generation**

```ts
const sent:number[]=[];
await playFramePlan(plan, async frame => { sent.push(frame.index); now += frame.index === 1 ? 90 : 1; }, {now:()=>now,wait});
expect(sent).toEqual([0,1,3]);
```

- [x] **Step 6: Implement deadline-based `playFramePlan`; never queue a late intermediate frame and always send the final frame unless aborted**
- [x] **Step 7: Run both focused tests, then `bun run check`**
- [x] **Step 8: Commit `feat(presentation): add measured deadline playback`**

### Task 2: StudioDocument v2 and Content-Addressed Assets

**Files:**
- Create: `packages/studio/document.ts`
- Create: `packages/studio/document.test.ts`
- Create: `packages/studio/assets.ts`
- Create: `packages/studio/assets.test.ts`
- Create: `packages/studio/repository.ts`
- Create: `packages/studio/repository.test.ts`

**Interfaces:**
- Produces: `StudioDocument`, `StudioPage`, `StudioButton`, `DynamicRegion`, `TransitionSpec`, `validateStudioDocument(input, context)`, `defaultStudioDocument()`.
- Produces: `VisualAssetStore.put(bytes)`, `.read(assetId)`, `.has(assetId)`; normalized assets are PNG and IDs are lowercase SHA-256.
- Produces: `StudioRepository.snapshot()`, `.apply(document, expectedVersion)`, `.putAsset(bytes)`.

- [x] **Step 1: Write failing document tests for a default page, standby, three motion triggers, custom background/icon references, fixed effects, dynamic regions, and strict unknown-field rejection**
- [x] **Step 2: Add failing tests proving old `PageConfig`/`streamdeck.board` input is rejected and document validation does not mutate input**
- [x] **Step 3: Run `bun test packages/studio/document.test.ts` and confirm missing-module failure**
- [x] **Step 4: Implement exact validators with these public shapes**

```ts
type StudioDocument={
  version:2; device:{kind:'streamdeck-classic-5x3'};
  defaultPageId:string; pages:StudioPage[]; standby:StudioAppearance;
  motion:{pageChange:TransitionSpec;unlock:TransitionSpec;reconnect:TransitionSpec};
};
type TransitionSpec={type:'none'|'crossfade'|'fade-through-black';durationMs:number};
```

- [x] **Step 5: Write failing asset tests for rotate-normalized PNG storage, duplicate deduplication, pixel limit, input byte limit, unsupported format, and traversal-resistant IDs**
- [x] **Step 6: Implement `VisualAssetStore` with Sharp metadata validation, 8MB/16MP limits, mode-0700 directory, and atomic exclusive write/rename publication**
- [x] **Step 7: Write failing repository tests for initial default document, optimistic version conflict, atomic save, and restart recovery**
- [x] **Step 8: Implement `StudioRepository`; store `studio.json` and `assets/` under the configured Streamhub data directory**
- [x] **Step 9: Run all studio domain tests and `bun run check`**
- [x] **Step 10: Commit `feat(studio): add v2 document and asset store`**

### Task 3: Full-LCD Renderer and Transition Compiler

**Status:** Implemented and regression-tested in `7c5112c`.

**Files:**
- Create: `packages/presentation/geometry.ts`
- Create: `packages/presentation/geometry.test.ts`
- Create: `packages/presentation/render.ts`
- Create: `packages/presentation/render.test.ts`
- Create: `packages/presentation/transitions.ts`
- Create: `packages/presentation/transitions.test.ts`
- Modify: `packages/streamdeck/pages.ts`
- Modify: `packages/streamdeck/pages.test.ts`

**Interfaces:**
- Produces: `streamDeckClassicGeometry`, `keyViewport(index)`, `extractKeyPngs(canvas)`.
- Produces: `DeckVisualRenderer.render(document, page, deckPage, assets): Promise<DeckCanvas>`.
- Produces: `TransitionCompiler.compile(from, to, spec): Promise<CompiledTransition>`.
- Adds a document-to-`PageConfig` adapter so existing stable dynamic slot allocation and press invalidation remain reused.

- [ ] **Step 1: Write failing geometry tests for all 15 exact viewports and 480×272 round-trip extraction**
- [ ] **Step 2: Run the focused test, implement immutable geometry helpers, and re-run green**
- [ ] **Step 3: Write failing renderer tests using a two-color fixture to prove background crop continuity, transparent fixed-button overlay, custom icon composition, standby rendering, and Studio/device pixel equality**
- [ ] **Step 4: Implement whole-canvas Sharp composition; render the background first and overlay only occupied 72×72 viewports**
- [ ] **Step 5: Write failing adapter tests proving fixed cells reserve capacity, dynamic records preserve stable cells, and signal press effects remain source-scoped**
- [ ] **Step 6: Implement the v2 adapter by composing the existing `PageBoard`; do not add another slot allocator**
- [ ] **Step 7: Write failing transition tests for `none`, midpoint crossfade, two-phase fade-through-black, exact final frame, duration bounds, and 15-key PNG output**
- [ ] **Step 8: Implement `TransitionCompiler` with deterministic frame offsets and a maximum of 12 frames/500ms**
- [ ] **Step 9: Run presentation/streamdeck focused tests and `bun run check`**
- [ ] **Step 10: Commit `feat(presentation): render full-deck animated frames`**

### Task 4: Authenticated Plugin Protocol and Runtime Presentation Service

**Status:** Implemented and regression-tested in `f8837f2`; signal polling and native session/app-context monitoring were completed with Task 6.

**Files:**
- Create: `packages/presentation/protocol.ts`
- Create: `packages/presentation/protocol.test.ts`
- Create: `packages/host/src/plugin-gateway.ts`
- Create: `packages/host/src/plugin-gateway.test.ts`
- Create: `packages/host/src/presentation.ts`
- Create: `packages/host/src/presentation.test.ts`
- Modify: `packages/host/src/server.ts`
- Modify: `packages/host/src/server.test.ts`
- Modify: `packages/host/src/runtime.ts`
- Modify: `packages/host/src/runtime.test.ts`
- Modify: `packages/host/src/config.ts`
- Modify: `packages/host/src/config.test.ts`

**Interfaces:**
- Produces strict message unions `PluginToRuntimeMessage` and `RuntimeToPluginMessage` plus `parsePluginMessage`/`parseRuntimeMessage`.
- Produces `startPluginGateway({port,token,onMessage})` returning `{url,publish,status,stop}`.
- Produces `startPresentationService({store,directory,gateway,execute,monitor,context})` returning `{apply,status,stop}`.
- Extends host config with `streamdeckPlugin?: {enabled:boolean;port:number;tokenFile:string}`; `tokenFile` must be absolute and mode-safe when read.

- [ ] **Step 1: Write failing protocol tests for every allowed message and rejection of unknown fields, wrong protocol versions, invalid coordinates, oversized frame counts, non-PNG data URIs, and stale revisions**
- [ ] **Step 2: Implement pure exact protocol parsing with protocol version `1` and bounded presentation payloads**
- [ ] **Step 3: Write failing gateway integration tests for Bearer authentication, browser-Origin rejection, latest snapshot on connect, one-device policy, message forwarding, and bounded cleanup**
- [ ] **Step 4: Implement a dedicated loopback Bun WebSocket server; keep plugin traffic off the source-ingest routes**
- [ ] **Step 5: Write failing presentation-service tests for initial snapshot, signal refresh, page-change transition, lock standby, unlock precompiled transition, reconnect trigger, stale down/up cancellation, and action execution only after final-frame `sent`**
- [ ] **Step 6: Implement the service using `PageBoard`, `DeckVisualRenderer`, `TransitionCompiler`, session/app-context monitors, and latest-generation coalescing**
- [ ] **Step 7: Add failing host config/runtime tests proving old `streamdeck.board` does not activate the plugin path and the new plugin config owns gateway/service cleanup**
- [ ] **Step 8: Integrate the service into `startHost`; retain old HID files but do not instantiate them from the new plugin configuration**
- [ ] **Step 9: Add authenticated `GET /v1/studio` and `POST /v1/studio/apply` host routes backed by the presentation service; preserve browser-Origin rejection**
- [ ] **Step 10: Run host/presentation tests and `bun run check`**
- [ ] **Step 11: Commit `feat(runtime): serve plugin presentations and input`**

### Task 5: Production Stream Deck Plugin, Cache, and Profile Setup

**Status:** Implemented and regression-tested in `5aea24f`, including a generated 15-cell profile.

**Files:**
- Create: `packages/streamdeck-plugin/package.json`
- Create: `packages/streamdeck-plugin/tsconfig.json`
- Create: `packages/streamdeck-plugin/src/cache.ts`
- Create: `packages/streamdeck-plugin/src/cache.test.ts`
- Create: `packages/streamdeck-plugin/src/client.ts`
- Create: `packages/streamdeck-plugin/src/client.test.ts`
- Create: `packages/streamdeck-plugin/src/plugin.ts`
- Create: `packages/streamdeck-plugin/com.streamhub.studio.sdPlugin/manifest.json`
- Create: `scripts/setup-streamdeck-plugin.ts`
- Create: `scripts/setup-streamdeck-plugin.test.ts`
- Modify: `package.json`
- Modify: `scripts/build.ts`

**Interfaces:**
- `PresentationCache.load()` returns only a completely validated latest generation; `.save()` atomically rotates current/previous.
- `RuntimeClient` reconnects with bounded exponential backoff and exposes parsed messages/key sends.
- `CanvasCell` registers 15 coordinate instances, forms a cells-ready barrier, plays frames, and forwards input only when enabled.
- `bun run streamdeck:setup` creates the shared mode-0700 directory/token, validates the plugin/profile assets, and reports the next user action without UI automation.

- [ ] **Step 1: Write failing cache tests for atomic save/load, corrupt current fallback, maximum two generations, and mode-private files**
- [ ] **Step 2: Implement cache under `~/Library/Application Support/Streamhub/plugin/`; decode only validated PNG data URIs and never pass external paths to `setImage`**
- [ ] **Step 3: Write failing RuntimeClient tests using a local test WebSocket for auth, reconnect, schema rejection, heartbeat timeout, and key-message serialization**
- [ ] **Step 4: Implement the client with injected URL/token/clock for tests**
- [ ] **Step 5: Write failing plugin-controller tests with fake key actions for 15-cell barrier, standby-first unlock, concurrent cell sends, playback cancellation, missing cells, held-key release barrier, and offline image**
- [ ] **Step 6: Implement the SDK adapter as a thin wrapper around the tested controller; do not execute apps or commands in the plugin**
- [ ] **Step 7: Create the production manifest and bundled offline/standby action images; expose only connection status, `Studio 열기`, and retry in the Property Inspector contract**
- [ ] **Step 8: Write failing setup tests using temporary HOME/config roots; require one shared token and an exact 15-cell profile asset inventory**
- [ ] **Step 9: Implement setup/build scripts and root commands `streamdeck:setup`, `streamdeck:plugin:build`, and `streamdeck:plugin:check`**
- [ ] **Step 10: Run plugin checks, root `bun run check`, and manifest validation**
- [ ] **Step 11: Commit `feat(streamdeck): add production canvas plugin`**

### Task 6: Canvas-First Studio and Apply Workflow

**Status:** Implemented and regression-tested, including a live browser render smoke test.

**Files:**
- Modify: `packages/editor/server.ts`
- Modify: `packages/editor/server.test.ts`
- Replace: `packages/editor/web/index.html`
- Replace: `packages/editor/web/app.ts`
- Replace: `packages/editor/web/style.css`
- Create: `packages/editor/web/model.ts`
- Create: `packages/editor/web/model.test.ts`
- Modify: `scripts/editor.ts`
- Modify: `README.md`

**Interfaces:**
- Studio bootstrap returns `{token,snapshot,sources,actions,runtimeStatus}` where `snapshot` is the repository v2 document/version.
- `POST /api/assets` returns a content-addressed asset ID without applying the document.
- `POST /api/draft` validates and autosaves the server-owned draft.
- `POST /api/apply` writes the v2 document with optimistic versioning and calls the Runtime admin endpoint.
- Browser `StudioModel` owns only the rendered snapshot and emits explicit commands; server remains source of truth.

- [ ] **Step 1: Write failing browser-model tests for select page/key, set page/standby background, add transparent app button, create Claude dynamic region, set unlock effect, undo/redo, and dirty/applied state**
- [ ] **Step 2: Implement pure `StudioModel` command reduction and serialization**
- [ ] **Step 3: Replace server tests with failing v2 flows for credential-free bootstrap, capability-protected asset/draft/apply, optimistic conflict, automatic draft recovery, Runtime unavailable status, and no HID/action execution from preview**
- [ ] **Step 4: Rework `startEditorServer` around `StudioRepository`; apply to the running host with its existing admin token and return actionable connection errors**
- [ ] **Step 5: Build the browser UI around the approved canvas-first PoC structure**

The visible primary controls are:

```text
Pages / Standby | 480×272 device canvas | Selected button or page inspector
Background      | Apply status           | Action, icon, opacity
Dynamic regions | Runtime/plugin status  | Page/unlock/reconnect motion
```

- [ ] **Step 6: Add background/icon upload, fixed button placement, page/standby switching, dynamic region keys/source, motion presets, Runtime/plugin connection status, undo/redo, and explicit `장치에 적용`**
- [ ] **Step 7: Ensure the device preview uses the shared geometry and server-rendered key/canvas assets rather than an independent CSS crop formula**
- [ ] **Step 8: Update `bun editor` startup/build, README installation, Stream Deck profile setup, Studio workflow, native screensaver limitation, and phase-7 checklist**
- [ ] **Step 9: Run browser model/server tests, `bun run editor` smoke startup on an available port, plugin checks, and root `bun run check`**
- [ ] **Step 10: Commit `feat(studio): ship plugin-managed canvas workflow`**

### Task 7: Phase 1–6 Integration Gate

**Files:**
- Create: `packages/presentation/integration.test.ts`
- Modify: `docs/superpowers/plans/2026-09-10-streamdeck-plugin-only-phases-1-6.md`

**Interfaces:**
- Consumes all prior task interfaces.
- Produces an automated gate before the user-assisted hardware phase.

- [ ] **Step 1: Write an integration test that boots a temporary store, repository, gateway, Runtime presentation service, and fake 15-cell plugin client**
- [ ] **Step 2: Assert background continuity, Firefox action mapping, dynamic Claude record assignment, page crossfade, lock standby, precompiled unlock animation, stale press cancellation, and Runtime reconnect**
- [ ] **Step 3: Run the integration test and fix only contract mismatches revealed by this vertical slice**
- [ ] **Step 4: Run `bun run check`, plugin package check/build, `git diff --check`, and inspect the built manifest**
- [ ] **Step 5: Record automated results and leave phase 7 hardware boxes unchecked for the joint session**
- [ ] **Step 6: Commit `test(streamdeck): gate plugin-only phase six`**

## Phase 7 Joint Hardware Checklist — Intentionally Deferred

- [ ] Install/link the production plugin and import the 15-cell Streamhub profile together.
- [ ] Set or confirm the exported native standby/screensaver image.
- [ ] Run ten lock/unlock cycles and capture warmup, cells-ready, first-frame-sent, final-frame-sent, p50, p95, and maximum.
- [ ] Verify page crossfade and fade-through-black unlock animation visually.
- [ ] Create and remove a real Claude session and verify stable automatic button assignment.
- [ ] Press Firefox and Claude session buttons and verify exactly one safe action each.
- [ ] Restart Runtime, restart Stream Deck App, and reconnect USB.
- [ ] Approve or reject the phase-8 direct HID deletion gate.
