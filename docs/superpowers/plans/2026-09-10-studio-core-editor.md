# Streamhub Studio Core Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Studio capable of authoring, styling, previewing, applying, and operating a three-page Stream Deck profile without JSON or Bundle ID entry.

**Architecture:** Replace the v2 mixed button union with a v3 document that separates action and appearance. Project v3 into the existing `PageBoard` safety state machine, add one shared Sharp-based key compositor, and expose focused browser APIs/models for pages, action catalogs, pickers, and drag/copy editing.

**Tech Stack:** Bun 1.4, TypeScript 5.9, Sharp 0.34, Bun HTTP, HTML/CSS browser UI, macOS `/usr/bin/open` and bounded native helpers.

**Spec:** `docs/superpowers/specs/2026-09-10-studio-core-and-runtime-data-design.md`

## Global Constraints

- Stream Deck App remains the sole physical device owner.
- Document version is exactly `3`; v2 is backed up and not migrated.
- Existing content-addressed image assets remain available after the reset.
- Button action and button appearance are independent values.
- `icon-and-label`, `icon-only`, `label-only`, and `hidden` are supported by one compositor.
- Browser input never receives admin/source/plugin tokens.
- Shell command strings are never executed; registered commands remain argv-only through `ActionRegistry`.

---

### Task 1: StudioDocument v3 and Safe v2 Reset

**Files:**
- Replace: `packages/studio/document.ts`
- Replace tests: `packages/studio/document.test.ts`
- Modify: `packages/studio/repository.ts`
- Modify tests: `packages/studio/repository.test.ts`

**Interfaces:**
- Produces: `StudioDocument`, `ButtonDefinition`, `ButtonAction`, `ButtonAppearance`, `ButtonContentMode`, `defaultStudioDocument()`, `validateStudioDocument()`.
- Later tasks consume these exact type names; do not add a parallel page/button schema.

```ts
export type StudioDocument = {
  version:3;
  id:string;
  device:{kind:'streamdeck-classic-5x3'};
  defaultPageId:string;
  pages:StudioPage[];
  standby:StudioAppearance;
  motion:{pageChange:TransitionSpec; unlock:TransitionSpec; reconnect:TransitionSpec};
};
```

`id` is a lower-case UUID generated once when the repository creates/resets the document. It provides a stable namespace for Runtime view/toggle state and is never regenerated on ordinary edits.

- [x] **Step 1: Write failing document tests**

```ts
const button = {
  id: 'firefox', index: 0,
  action: {type: 'open-app', bundleId: 'org.mozilla.firefox'},
  appearance: {
    contentMode: 'icon-and-label',
    icon: {assetId: 'a'.repeat(64), fit: 'contain'},
    label: {text: 'Firefox', position: 'bottom', size: 'medium', color: '#ffffff'},
    background: {color: '#101820', opacity: 0.75},
  },
};
expect(validateStudioDocument({...defaultStudioDocument(), pages:[{id:'home',title:'홈',buttons:[button]}]}, context).version).toBe(3);
```

Cover invalid document UUID, duplicate button IDs, duplicate indices, unknown fields, missing icon for icon modes, missing label for label modes, hidden content, invalid colors/opacities, page reference integrity, and the 32-page limit.

- [x] **Step 2: Run the document tests and confirm v2 rejects the new shape**

Run: `bun test packages/studio/document.test.ts`

Expected: FAIL because v3 types and validation do not exist.

- [x] **Step 3: Implement the v3 types and strict validator**

Use the unions and appearance fields from spec sections 5 and 6. Copy arrays/objects into a new object; never return the caller's mutable input.

- [x] **Step 4: Write the repository reset test**

```ts
expect(repository.snapshot().document.version).toBe(3);
expect(readdirSync(directory).some(name => /^studio\.v2\..+\.backup\.json$/.test(name))).toBe(true);
expect(await repository.assets.read(existingAssetId)).toEqual(existingAssetBytes);
```

- [x] **Step 5: Implement one-time v2 backup and v3 initialization**

When `studio.json` parses as version 2, rename it to `studio.v2.<UTC compact timestamp>.backup.json`, generate one new document UUID, publish the default v3 document atomically, and return `{resetFromVersion:2, backupPath}` once in the snapshot metadata. Do not delete `assets/`.

- [x] **Step 6: Verify and commit**

Run: `bun test packages/studio/document.test.ts packages/studio/repository.test.ts && bun run typecheck`

Commit: `feat(studio): introduce version three button model`

---

### Task 2: Shared Button Compositor

**Files:**
- Create: `packages/presentation/button-compositor.ts`
- Create: `packages/presentation/button-compositor.test.ts`
- Modify: `packages/presentation/render.ts`
- Modify: `packages/presentation/render.test.ts`
- Modify: `packages/editor/server.ts`
- Modify: `packages/editor/server.test.ts`

**Interfaces:**
- Consumes: v3 `ButtonAppearance` and the existing `VisualAssetStore` reader.
- Produces: `composeButton(input: ComposeButtonInput): Promise<Buffer>` returning one opaque 72×72 PNG.

```ts
export type ComposeButtonInput = {
  appearance: ButtonAppearance;
  background: Buffer;
  assets: AssetReader;
  runtime?: {label?: string; detail?: string; badge?: string};
};
```

- [x] **Step 1: Write four golden pixel tests**

Create deterministic 72×72 backgrounds and icons. Assert per-mode SHA-256 hashes are distinct, `hidden` equals the untouched background, icon-and-label contains icon and label sample pixels, and label-only contains no icon pixels.

- [x] **Step 2: Run the compositor test and confirm the module is missing**

Run: `bun test packages/presentation/button-compositor.test.ts`

Expected: FAIL with module-not-found.

- [x] **Step 3: Implement the fixed layer order**

Composite `background → button background → icon → label → runtime badge`. Escape label text before creating bounded local SVG; allow only declared font size/position/color. Never load external SVG, fonts, or URLs.

- [x] **Step 4: Replace the existing icon-replaces-key branch**

`DeckVisualRenderer` must crop the page background cell first, then call `composeButton` for every occupied fixed or dynamic key. Remove the branch that returns an uploaded icon as the entire key.

- [x] **Step 5: Add a Studio preview endpoint using the same compositor**

Add `POST /api/preview/button` with the editor capability header. Input is one validated v3 appearance and an asset-backed background cell; output is `image/png`. Enforce the existing 9 MiB request ceiling and same-origin policy.

- [x] **Step 6: Verify and commit**

Run: `bun test packages/presentation/button-compositor.test.ts packages/presentation/render.test.ts packages/editor/server.test.ts`

Commit: `feat(studio): share button composition with runtime`

---

### Task 3: Page Navigation State Machine

**Files:**
- Modify: `packages/streamdeck/pages.ts`
- Modify: `packages/streamdeck/pages.test.ts`
- Modify: `packages/host/src/presentation.ts`
- Modify: `packages/host/src/presentation.test.ts`

**Interfaces:**
- Consumes: v3 `ButtonAction` navigation variants.
- Produces: page-order navigation and read-only page indicator through the existing `PageBoard.down/up/page` contract.

- [x] **Step 1: Write failing page tests**

```ts
expect(board.page().keys[12]).toMatchObject({type:'tile', label:'1 / 3', enabled:false});
board.down(14); expect(board.up(14)).toMatchObject({type:'navigate'});
expect(board.page().viewId).toBe('web');
board.down(10); board.up(10);
expect(board.page().viewId).toBe('home');
```

Cover boundary no-op, direct target, manual pinning, `resume-auto-page`, stale down/up cancellation, deleted/unknown target rejection, and distinction from dynamic list pagination.

- [x] **Step 2: Run the focused tests and confirm the new action variants fail validation**

Run: `bun test packages/streamdeck/pages.test.ts`

- [x] **Step 3: Project v3 buttons into `PageBoard` without losing appearance identity**

Add an internal `FixedBinding` containing `{pageId, buttonId, action}`. `page-indicator` renders `${outerIndex + 1} / ${pageCount}` and never yields an effect.

- [x] **Step 4: Keep presentation input gating unchanged**

Navigation returns only a page intent; `startPresentationService` publishes trigger `page`, cancels the old generation, and does not call the external effect executor.

- [x] **Step 5: Verify and commit**

Run: `bun test packages/streamdeck/pages.test.ts packages/host/src/presentation.test.ts`

Commit: `feat(studio): add first-class page navigation actions`

---

### Task 4: Page Editing Commands

**Files:**
- Replace: `packages/editor/editing.ts`
- Replace tests: `packages/editor/editing.test.ts`
- Modify: `packages/editor/web/model.ts`
- Modify: `packages/editor/web/model.test.ts`

**Interfaces:**
- Produces pure commands: `addPage`, `renamePage`, `duplicatePage`, `movePage`, `setDefaultPage`, `deletePage`, `pageReferences`.
- `StudioModel` wraps each command in one undo entry and updates selection deterministically.

- [x] **Step 1: Write failing command tests**

```ts
expect(renamePage(document,'home','홈').pages[0].title).toBe('홈');
expect(movePage(document,'media',-1).pages.map(page=>page.id)).toEqual(['home','media','web']);
expect(pageReferences(document,'web')).toEqual([{pageId:'home',buttonId:'to-web'}]);
expect(()=>deletePage(document,'web')).toThrow('page is still referenced');
```

Cover one-page deletion, ID generation, duplicate self-reference remap, default reassignment, 32-page ceiling, and immutability.

- [x] **Step 2: Run the editing tests and confirm v2 helpers cannot accept v3 documents**

Run: `bun test packages/editor/editing.test.ts packages/editor/web/model.test.ts`

- [x] **Step 3: Implement pure v3 commands and model wrappers**

`deletePage` takes an optional replacement ID only when deleting the default page. It never rewrites incoming page buttons silently; references must be resolved explicitly.

- [x] **Step 4: Verify and commit**

Run: `bun test packages/editor/editing.test.ts packages/editor/web/model.test.ts`

Commit: `feat(studio): add complete page editing commands`

---

### Task 5: Single-Action Catalog and Executor

**Files:**
- Create: `packages/actions/system.ts`
- Create: `packages/actions/system.test.ts`
- Modify: `packages/host/src/key-actions.ts`
- Modify: `packages/host/src/key-actions.test.ts`
- Modify: `packages/host/src/presentation.ts`
- Modify: `packages/host/src/presentation.test.ts`

**Interfaces:**
- Produces: `SystemActionCatalog`, `validateButtonAction(action)`, `executeButtonAction(action, signal)`.
- Keeps registered commands delegated to `ActionRegistry`.

```ts
export const MEDIA_COMMANDS = ['play-pause','previous-track','next-track','volume-up','volume-down','mute-toggle'] as const;
export const KEY_CODES = ['command','option','control','shift','a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z','0','1','2','3','4','5','6','7','8','9','enter','escape','tab','space','left','right','up','down','f1','f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12'] as const;
```

- [ ] **Step 1: Write failing validation and executor tests**

Cover app, absolute path, HTTPS URL, hotkey uniqueness/order, text modes, media enum, registered command, `none`, cancellation, output cap, timeout, and exactly-one invocation.

- [ ] **Step 2: Run focused tests and confirm missing system action module**

Run: `bun test packages/actions/system.test.ts packages/host/src/key-actions.test.ts`

- [ ] **Step 3: Implement shell-free system execution**

- App/path/URL: `/usr/bin/open` with separate argv elements.
- Hotkey/text/media: a compiled Swift helper under `.streamhub/native/system-actions/<source-hash>` using `CGEvent`; accept one validated JSON line on stdin and return one bounded JSON result.
- Registered command: existing `ActionRegistry`.
- `none`, page navigation, and page indicator: no external executor call.

- [ ] **Step 4: Add permission failure semantics**

If Accessibility permission is absent, hotkey/text returns `accessibility-permission-required`; it must not retry or partially send keys. Media keys use the supported system event path and return a distinct unsupported error if unavailable.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/actions/system.test.ts packages/host/src/key-actions.test.ts packages/host/src/presentation.test.ts`

Commit: `feat(actions): execute core Stream Deck system actions`

---

### Task 6: App, Path, and Action Catalog APIs

**Files:**
- Create: `packages/host/src/catalog.ts`
- Create: `packages/host/src/catalog.test.ts`
- Modify: `packages/editor/server.ts`
- Modify: `packages/editor/server.test.ts`

**Interfaces:**
- Produces credential-free `GET /api/catalog/apps`, `POST /api/picker/path`, and `GET /api/catalog/actions`.

```ts
export type AppCatalogItem = {name:string; bundleId:string; path:string; iconPng?:string};
export type RegisteredActionCatalogItem = {name:string; args:string[]};
```

- [ ] **Step 1: Test catalog normalization and privacy**

Use fake Spotlight/LaunchServices output. Reject duplicate bundle IDs, NULs, relative paths, icons over 512 KiB, and fields outside the response type. Assert no environment variables or tokens appear.

- [ ] **Step 2: Implement app discovery and bounded caching**

Use a dependency-injected macOS catalog reader, sort by localized name then bundle ID, cache for 30 seconds, and limit output to 2,000 apps.

- [ ] **Step 3: Implement picker delegation**

`POST /api/picker/path` accepts `{kind:'file'|'folder'}` and calls an injected native picker only from a same-origin editor request. Return one absolute path or `{cancelled:true}`; never accept a caller-supplied path as picker output.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/host/src/catalog.test.ts packages/editor/server.test.ts`

Commit: `feat(studio): expose safe local action catalogs`

---

### Task 7: Four-Pane Studio UI and Inspectors

**Files:**
- Split: `packages/editor/web/app.ts`
- Create: `packages/editor/web/state.ts`
- Create: `packages/editor/web/pages-view.ts`
- Create: `packages/editor/web/action-library.ts`
- Create: `packages/editor/web/canvas-view.ts`
- Create: `packages/editor/web/inspector-view.ts`
- Modify: `packages/editor/web/index.html`
- Replace: `packages/editor/web/style.css`
- Create tests: `packages/editor/web/state.test.ts`
- Modify tests: `packages/editor/web/model.test.ts`

**Interfaces:**
- Produces a four-pane UI: page sidebar, searchable action library, 5×3 canvas, contextual inspector.
- Components receive `StudioModel` commands; they do not mutate document objects directly.

- [ ] **Step 1: Write state tests for selection and visible inspector fields**

```ts
expect(inspectorFor(openAppButton)).toEqual(['action','content-mode','icon','label','background']);
expect(inspectorFor(pageIndicatorButton)).toEqual(['content-mode','icon','label','background']);
expect(filteredActions('페이지')).toEqual(expect.arrayContaining(['go-to-page','previous-page','next-page','page-indicator']));
```

- [ ] **Step 2: Split browser responsibilities before adding controls**

Move fetch/bootstrap/apply into `state.ts`; page DOM into `pages-view.ts`; palette DOM into `action-library.ts`; geometry/drop targets into `canvas-view.ts`; form visibility and validation into `inspector-view.ts`. Keep one `render()` coordinator in `app.ts`.

- [ ] **Step 3: Implement page sidebar and action library**

Expose add, rename, duplicate, delete, reorder, default, and standby. Group exact actions from spec section 4.2; search matches Korean label and stable action type.

- [ ] **Step 4: Implement action-specific inspectors**

Use app catalog picker, path picker, URL input, hotkey capture, text mode, media enum, registered command args, page target, and indicator. Do not show irrelevant fields.

- [ ] **Step 5: Implement four appearance modes**

Show a four-option segmented control. Disable label fields when mode lacks label; disable icon fields when mode lacks icon. Hidden buttons remain outlined only in edit mode.

- [ ] **Step 6: Verify and commit**

Run: `bun test packages/editor/web packages/editor/server.test.ts && bun run typecheck`

Commit: `feat(studio): build core action authoring interface`

---

### Task 8: Drag, Copy, Paste, and History

**Files:**
- Create: `packages/editor/web/clipboard.ts`
- Create: `packages/editor/web/clipboard.test.ts`
- Modify: `packages/editor/web/model.ts`
- Modify: `packages/editor/web/model.test.ts`
- Modify: `packages/editor/web/canvas-view.ts`
- Modify: `packages/editor/web/pages-view.ts`

**Interfaces:**
- Produces `moveButton`, `copyButton`, `pasteButton`, `duplicateButton`, `removeButton` as one-command undo entries.
- Clipboard stores one structured-cloned button without index; paste assigns a fresh ID and target index.

- [ ] **Step 1: Write failing collision and history tests**

Cover blank→occupied move, occupied→occupied swap confirmation rejection, cross-page paste, fresh ID, missing asset preservation, undo/redo branch, and keyboard shortcuts that ignore focused text inputs.

- [ ] **Step 2: Implement pure clipboard transforms**

```ts
type ButtonClipboard = {version:1; button:Omit<ButtonDefinition,'id'|'index'>};
```

Clipboard data stays in Studio memory; do not write button JSON to the system clipboard.

- [ ] **Step 3: Add pointer drag/drop and keyboard commands**

Support `⌘C`, `⌘V`, `⌘D`, Delete, `⌘Z`, and `⇧⌘Z`. Every successful gesture creates exactly one history entry and one autosaved draft.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/editor/web/clipboard.test.ts packages/editor/web/model.test.ts`

Commit: `feat(studio): add fast button editing gestures`

---

### Task 9: Core Editor Vertical Gate and Hardware Acceptance

**Files:**
- Create: `packages/editor/core-editor.integration.test.ts`
- Create: `docs/validation/studio-core-editor.md`
- Modify: `README.md`

**Interfaces:**
- Consumes all prior core-editor tasks.
- Produces the committed M1 gate required before advanced actions or Runtime data work.

- [ ] **Step 1: Write one automated blank-to-three-pages test**

Boot a temporary repository, Runtime presentation service, fake plugin, and editor server. Create `홈`, `웹`, `미디어`; configure Firefox, website, hotkey, text, media, next, previous, direct target, and indicator; apply; press/release every executable button; assert exact effects and final frame hashes.

- [ ] **Step 2: Run the integration and full automated gates**

Run: `bun test packages/editor/core-editor.integration.test.ts && bun run check && bun run streamdeck:plugin:check && git diff --check`

- [ ] **Step 3: Perform the user-assisted device checklist**

Record Stream Deck model/firmware, Stream Deck App version, macOS version, commit, start/end time, and pass/fail for the six flows in spec section 3. Confirm each system action executes exactly once and page indicator matches the displayed page.

- [ ] **Step 4: Commit evidence and documentation**

Commit: `test(studio): approve core editor on hardware`
