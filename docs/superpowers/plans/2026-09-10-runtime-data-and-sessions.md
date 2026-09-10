# Streamhub Runtime Data and Session Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Studio place secure, stable dynamic button regions backed by Runtime records, then provide real Claude Code and Codex session presets on that common model.

**Architecture:** Trusted adapters register immutable `SourceDefinition` schemas and publish validated `RuntimeRecord` values. Studio stores declarative filters, templates, and allowed action bindings; a pure allocator maps records to keys while Runtime revalidates the current record and presentation generation on key-up. Claude and Codex are adapters, not special page types.

**Tech Stack:** Bun 1.4, TypeScript 5.9, Bun SQLite/HTTP, existing presentation compositor, Claude Code CLI, experimental Codex app-server JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-09-10-studio-core-and-runtime-data-design.md`, sections 8–14 and stages 7–9

## Constraints

- Source definitions come only from installed Runtime code/configuration, never from source payloads.
- Source payloads cannot name executables, actions, validators, templates, or record field mappings.
- Unknown fields and wrong types reject the whole command before persistence.
- Studio receives no source token, environment, raw stdout, or unredacted adapter error.
- `(source, id)` is the stable record identity; presentation bindings additionally capture record revision and generation.
- Claude/Codex support is not marked stable until the exact installed CLI version and protocol pass contract tests.
- No window-title, process-title, accessibility-tree, or screen-text scraping is used to guess session IDs.

---

### Task 1: Trusted Source Registry

**Files:**
- Create: `packages/sources/registry.ts`
- Create: `packages/sources/registry.test.ts`
- Modify: `packages/host/src/runtime.ts`
- Modify tests: `packages/host/src/runtime.test.ts`

**Interfaces:**

```ts
export type SourceDefinition = {
  id:string;
  name:string;
  recordKind:'live'|'event'|'gauge';
  fields:SourceField[];
  actions:SourceAction[];
};

export type SourceField = {
  key:string; label:string;
  type:'string'|'number'|'boolean'|'timestamp'|'enum';
  values?:string[];
  filterable:boolean; displayable:boolean;
};

export type SourceAction = {
  id:string; label:string;
  args:Record<string,{
    type:'string'|'number'|'boolean';
    recordFields:string[];
  }>;
};

export class SourceRegistry {
  register(definition:SourceDefinition): void;
  definition(id:string): SourceDefinition | undefined;
  list(): SourceDefinition[];
}
```

`recordFields` use one shared namespace. The reserved fields are `id`, `label`, `detail`, `level`, `freshness`, `createdAt`, and `updatedAt`; adapter fields are addressed as `attributes.<key>`. The registry exports `resolveRecordField(definition, path)` so ingestion, filters, templates, and action bindings cannot disagree about names or primitive types.

- [ ] **Step 1: Write failing registry validation tests**

Cover duplicate source/field/action IDs, invalid identifier grammar, more than 64 fields or 32 actions, duplicate enum values, collisions with reserved record fields, action argument references to unknown/non-compatible field paths, non-displayable label mapping, and mutation after registration.

- [ ] **Step 2: Run the focused test**

Run: `bun test packages/sources/registry.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement immutable registration**

Deep-clone and freeze accepted definitions. IDs use `^[a-z0-9][a-z0-9_-]{0,63}$`; labels are non-control strings up to 64 UTF-16 code units. Registration is startup-only and duplicate IDs fail Runtime startup.

- [ ] **Step 4: Inject the registry into Runtime**

`startRuntime` builds the definition registry before server/presentation startup and passes the same instance to ingestion, Studio APIs, dynamic rendering, and dynamic action execution. Adapter instances are attached by the supervisor in Task 3 only after their definitions are present.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/sources/registry.test.ts packages/host/src/runtime.test.ts && bun run typecheck`

Commit: `feat(runtime): register trusted data source schemas`

---

### Task 2: RuntimeRecord Attributes and Strict Ingestion

**Files:**
- Replace: `packages/core/src/index.ts`
- Replace tests: `packages/core/src/index.test.ts`
- Modify: `packages/host/src/validation.ts`
- Modify tests: `packages/host/src/server.test.ts`
- Modify: `packages/host/src/store.ts`
- Modify tests: `packages/host/src/store.test.ts`
- Modify: `packages/sources/command.ts`
- Modify tests: `packages/sources/command.test.ts`

**Interfaces:**

```ts
export type RuntimeRecord = {
  source:string; id:string; kind:'live'|'event'|'gauge';
  label:string; detail?:string; level:'info'|'warn'|'urgent';
  freshness:'fresh'|'stale';
  attributes:Record<string,string|number|boolean>;
  revision:number; createdAt:number; updatedAt:number;
};

export type IncomingRecord = Omit<RuntimeRecord,
  'source'|'freshness'|'revision'|'createdAt'|'updatedAt'>;
```

- [ ] **Step 1: Write core transition tests with attributes**

Preserve delivery idempotency, snapshot watermark, two-miss removal, stale restore, source/total limits, and revision behavior. Add deep-clone tests for `attributes` and remove all assertions that allow `press` on a record.

- [ ] **Step 2: Write schema-driven server tests**

Given a registered definition, accept all valid primitive fields. Reject missing source schema, unknown attributes, wrong primitives, invalid enum values, non-finite numbers, more than 32 attributes, label/detail limits, `press`, and all extra top-level fields.

- [ ] **Step 3: Implement `parseRecord(definition, input)`**

Validate before calling `store.apply`. Store only normalized primitives. A rejected command does not consume `deliveryId` and does not advance the revision.

- [ ] **Step 4: Upgrade persistence format explicitly**

Set SQLite state row version to `2`. On version 1, parse the old state, remove `press` from records/discoveries, add empty `attributes`, validate capacity, and commit version 2 in one transaction. Unknown versions stop startup without overwriting the row.

- [ ] **Step 5: Update the demo command source**

Register a `local-command` live definition with `status` and `exitCode` fields. Publish those attributes; command execution remains owned by the existing registered action, not by the record.

- [ ] **Step 6: Verify and commit**

Run: `bun test packages/core/src/index.test.ts packages/host/src/server.test.ts packages/host/src/store.test.ts packages/sources/command.test.ts`

Commit: `feat(runtime): validate common runtime records`

---

### Task 3: Source Lifecycle, Health, and Studio-Safe APIs

**Files:**
- Create: `packages/sources/supervisor.ts`
- Create: `packages/sources/supervisor.test.ts`
- Modify: `packages/host/src/server.ts`
- Modify tests: `packages/host/src/server.test.ts`
- Modify: `packages/editor/server.ts`
- Modify tests: `packages/editor/server.test.ts`

**Interfaces:**

```ts
export type SourceHealth = {
  sourceId:string;
  status:'healthy'|'delayed'|'error'|'stopped';
  recordCount:number;
  lastSuccessAt?:number;
  message?:string;
};

export interface SourceAdapter {
  list(signal:AbortSignal):Promise<IncomingRecord[]>;
  invoke(actionId:string, recordId:string, args:Record<string,unknown>, signal:AbortSignal):Promise<void>;
}
```

The supervisor adds `attach(sourceId, adapter)` and `adapter(sourceId)` lookups. Attachment fails if the definition is missing or an adapter is already attached; stopping an adapter does not delete its trusted definition.

- [ ] **Step 1: Write supervisor tests with a fake adapter and clock**

Cover initial poll, successful snapshot, configurable interval clamped to `1..60` seconds, timeout, exponential error backoff capped at 60 seconds, restart, stop, stale marking, error redaction, and no overlapping polls.

- [ ] **Step 2: Implement source supervision**

Each adapter has one abort controller and one scheduled poll. A failed list calls `markStale` and preserves records. A successful full list uses `beginSnapshot` plus `membership`; explicit removals still use `remove`.

- [ ] **Step 3: Add admin Runtime APIs**

- `GET /v1/source-definitions`
- `GET /v1/source-health`
- `GET /v1/sources/:id/sample?limit=20`
- `POST /v1/sources/:id/restart`

Require the admin token and reject browser origins as existing Runtime routes do. Samples return normalized records only and cap at 20.

- [ ] **Step 4: Add credential-free editor projections**

Expose same-origin, editor-capability routes under `/api/data-sources`. Project only definition, health, bounded samples, and reverse document references. The restart route sends the admin request server-to-server; the browser never sees the admin token.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/sources/supervisor.test.ts packages/host/src/server.test.ts packages/editor/server.test.ts`

Commit: `feat(studio): expose safe data source health`

---

### Task 4: Studio Data Source Screen and Sample Workspace

**Files:**
- Create: `packages/editor/web/data-sources-view.ts`
- Create: `packages/editor/web/data-sources-view.test.ts`
- Create: `packages/editor/web/sample-records.ts`
- Create: `packages/editor/web/sample-records.test.ts`
- Modify: `packages/editor/web/app.ts`
- Modify: `packages/editor/web/state.ts`
- Modify: `packages/editor/web/style.css`

- [ ] **Step 1: Write view-model tests**

Assert healthy/delayed/error/stopped copy, count and last-success formatting, used-page/region links, restart availability, offline Runtime behavior, redacted errors, and empty/loading states.

- [ ] **Step 2: Implement a separate `데이터 소스` destination**

List source name, adapter kind, status, current count, last success, recent records, and uses. Selecting a use navigates back to that page and region. Restart asks for confirmation only when a poll is currently active.

- [ ] **Step 3: Add schema-constrained local sample records**

Samples live in browser state keyed by source ID and never call Runtime ingestion. Form controls derive from `SourceField`; reject unknown fields and enum values. Mark all canvas keys rendered from samples with a `샘플` editing badge excluded from device output.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/editor/web/data-sources-view.test.ts packages/editor/web/sample-records.test.ts && bun run typecheck`

Commit: `feat(studio): manage runtime data sources visually`

---

### Task 5: Dynamic Region Document Model and Inspector

**Files:**
- Modify: `packages/studio/document.ts`
- Modify tests: `packages/studio/document.test.ts`
- Modify: `packages/editor/editing.ts`
- Modify tests: `packages/editor/editing.test.ts`
- Create: `packages/editor/web/dynamic-region-editor.ts`
- Create: `packages/editor/web/dynamic-region-editor.test.ts`
- Modify: `packages/editor/web/action-library.ts`
- Modify: `packages/editor/web/canvas-view.ts`
- Modify: `packages/editor/web/inspector-view.ts`

**Interfaces:**
- Add the spec's `DynamicRegionDefinition`, `FilterExpression`, `DynamicButtonTemplate`, `AppearanceRule`, and `DynamicActionBinding` to each page's `dynamicRegions` array.

- [ ] **Step 1: Write strict document tests**

Reject overlapping regions/buttons, duplicate/non-ordered keys, keys outside `0..14`, empty regions, unknown source/field/action IDs, incompatible filter values, non-displayable template fields, rules with wrong types, unmapped required action args, and page-navigation keys inside a region.

- [ ] **Step 2: Implement context-aware document validation**

`validateStudioDocument` receives a source-definition lookup when dynamic regions exist. It returns path-specific errors such as `pages[1].dynamicRegions[0].filter.all[2].field`. A document referencing an unavailable source cannot be applied.

- [ ] **Step 3: Write editor command tests**

Cover create region from a contiguous drag, resize, move, delete, collision refusal, source switch resetting invalid fields, and one undo entry per command.

- [ ] **Step 4: Build the dynamic region inspector**

Provide source, keys, filters, order, overflow, empty state, template, appearance rules, and on-press action. Controls are generated from registered source schemas. The canvas distinguishes region range from ordinary selected buttons.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/studio/document.test.ts packages/editor/editing.test.ts packages/editor/web/dynamic-region-editor.test.ts`

Commit: `feat(studio): author schema-backed dynamic regions`

---

### Task 6: Stable Dynamic Allocation and Pagination

**Files:**
- Create: `packages/presentation/dynamic-region.ts`
- Create: `packages/presentation/dynamic-region.test.ts`
- Modify: `packages/host/src/store.ts`
- Modify tests: `packages/host/src/store.test.ts`
- Modify: `packages/host/src/presentation.ts`
- Modify tests: `packages/host/src/presentation.test.ts`

**Interfaces:**

```ts
export type RegionViewState = {
  page:number;
  slots:Record<number,{source:string; id:string}>;
};

export function allocateRegion(input:{
  definition:DynamicRegionDefinition;
  records:RuntimeRecord[];
  previous?:RegionViewState;
}): {state:RegionViewState; bindings:DynamicBinding[]};
```

- [ ] **Step 1: Write the allocator matrix**

Test zero, one, capacity, and overflow records; stable slot after updates; holes retained after removal; new records fill holes; urgent/recent/label ordering for new placements; paginate versus replace-oldest; page clamping; stale appearance; and isolated pagination for two regions.

- [ ] **Step 2: Implement pure filtering and allocation**

Evaluate only `equals`, `not-equals`, and `one-of` against declared primitive fields. Preserve surviving `(source,id)` slots before considering order. Persist only `RegionViewState` in the existing `view_state` table using key `dynamic/<documentId>/<pageId>/<regionId>`.

- [ ] **Step 3: Render through the shared compositor**

Resolve label/detail fields and first matching appearance rule, then call `composeButton`. Empty background emits the untouched crop; placeholder uses an explicit Studio-authored appearance. Stale records retain content and receive the standard stale badge.

- [ ] **Step 4: Add region navigation actions**

Implement `dynamic-previous`, `dynamic-next`, and `urgent-pin` with a required `regionId`. They change only that region's `view_state`, publish a new presentation generation, and never change the outer Studio page.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/presentation/dynamic-region.test.ts packages/host/src/store.test.ts packages/host/src/presentation.test.ts`

Commit: `feat(runtime): allocate stable dynamic button regions`

---

### Task 7: Revision-Safe Dynamic Actions

**Files:**
- Create: `packages/host/src/dynamic-actions.ts`
- Create: `packages/host/src/dynamic-actions.test.ts`
- Modify: `packages/host/src/presentation.ts`
- Modify tests: `packages/host/src/presentation.test.ts`

**Interfaces:**

```ts
export type DynamicPressBinding = {
  generation:number; bindingRevision:number;
  sourceId:string; recordId:string; recordRevision:number;
  regionId:string; actionId:string;
  args:Record<string,{recordField:string}>;
};
```

- [ ] **Step 1: Write fail-closed action tests**

Reject missing source/action/record, changed record revision, changed generation, changed region binding, wrong argument type, source/action ownership mismatch, stale down/up, duplicate key-up, and concurrent document apply. Assert one adapter invocation only for the exact current binding.

- [ ] **Step 2: Capture immutable bindings on key-down**

Store the complete `DynamicPressBinding`; do not re-derive action identity from a key index on key-up. Bind arguments from the current record only after rechecking all captured IDs and revisions.

- [ ] **Step 3: Invoke only registered adapter actions**

Look up the adapter and `SourceAction` in `SourceRegistry`. Reject extra args and map only declared `recordField` values. Abort invocation on page transition, lock, disconnect, source restart, or Runtime shutdown.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/host/src/dynamic-actions.test.ts packages/host/src/presentation.test.ts`

Commit: `feat(runtime): bind dynamic actions to current records`

---

### Task 8: Demo Source Vertical Gate

**Files:**
- Create: `packages/host/src/dynamic-source.integration.test.ts`
- Create: `scripts/demo-dynamic-source.ts`
- Create: `docs/validation/runtime-dynamic-source.md`

- [ ] **Step 1: Write an end-to-end demo source test**

Start temporary registry/store/server/presentation/editor/plugin fakes. Publish 0, 1, 5, and 8 records into a five-key region; update, omit twice, fail the source, paginate, and press one record. Assert stable slots, stale rendering, exact binding, and frame hashes.

- [ ] **Step 2: Add a deterministic manual demo**

`bun run demo:dynamic-source` cycles the same scenarios with fixed IDs and prints the active key-to-record map. It uses a generated source token from test config and never exposes it through Studio.

- [ ] **Step 3: Run M3 infrastructure gates**

Run: `bun test packages/host/src/dynamic-source.integration.test.ts && bun run check && bun run streamdeck:plugin:check && git diff --check`

- [ ] **Step 4: Commit the generic data milestone**

Commit: `test(runtime): approve generic dynamic source flow`

---

### Task 9: Claude Code Session Adapter and Preset

**Files:**
- Create: `packages/sources/claude-sessions.ts`
- Create: `packages/sources/claude-sessions.test.ts`
- Create: `packages/host/native/open-session.applescript`
- Create: `packages/host/src/session-launcher.ts`
- Create: `packages/host/src/session-launcher.test.ts`
- Create: `packages/studio/presets/claude-sessions.ts`
- Create: `packages/studio/presets/claude-sessions.test.ts`

**Contract:**
- Discovery executes the verified argv `[/Users/lago/.local/bin/claude, 'agents', '--json', '--all']` with a 3-second timeout and 1 MiB output cap. Production resolves the executable from validated config; the literal path is a development fixture, not a portable default. Completed sessions remain eligible for 15 minutes by `updatedAt`, then disappear through normal two-snapshot membership removal.
- Open executes the documented `claude attach <id>` flow in a new Terminal session.

- [ ] **Step 1: Capture and sanitize CLI fixtures**

Record fixtures for zero/running/waiting/done/failed sessions and malformed/version-changed output without names, prompts, paths, or message bodies. Contract tests define exactly which CLI fields become `id`, `label`, `detail`, `state`, `project`, and timestamps.

- [ ] **Step 2: Implement strict list parsing**

Reject the entire poll on invalid JSON, unknown required shape, duplicate IDs, control characters, or limits over 1,000 sessions. Extra CLI fields are ignored only after required fields validate; raw output is never persisted or returned to Studio.

- [ ] **Step 3: Implement a constrained visible-session launcher**

Validate the adapter-owned session ID against the fixture-derived grammar and cap it at 128 characters. Call a fixed AppleScript file with separate argv; the script builds one Terminal `do script` using only a fixed configured executable plus AppleScript's quoted-form encoding of the validated ID. It exposes no arbitrary CLI arguments and returns after Terminal accepts the command, without retry.

- [ ] **Step 4: Register definition, action, and editable preset**

Register live fields `state` and `project` plus action `attach-session(sessionId <- id)`. Use the reserved `updatedAt` field rather than duplicating it in `attributes`. The preset expands into an ordinary region with state appearance rules and may be edited or deleted like any other region.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/sources/claude-sessions.test.ts packages/host/src/session-launcher.test.ts packages/studio/presets/claude-sessions.test.ts`

Commit: `feat(sources): add Claude Code session buttons`

---

### Task 10: Codex Session Adapter and Preset

**Files:**
- Create: `packages/sources/codex-sessions.ts`
- Create: `packages/sources/codex-sessions.test.ts`
- Create: `packages/sources/codex-app-server.ts`
- Create: `packages/sources/codex-app-server.test.ts`
- Create: `packages/studio/presets/codex-sessions.ts`
- Create: `packages/studio/presets/codex-sessions.test.ts`
- Modify: `packages/host/src/session-launcher.ts`
- Modify tests: `packages/host/src/session-launcher.test.ts`

**Contract:**
- Discovery starts `[/Users/lago/.local/bin/codex, 'app-server', '--listen', 'stdio://', '--strict-config']`, performs JSON-RPC initialization, then calls `thread/list`; tests are pinned to the installed protocol fixture and an explicit client version. Production resolves the executable from validated config; the literal path is a development fixture.
- Open uses the verified CLI argv `codex resume <thread-id>` in a new Terminal session. No unverified `codex://thread/...` deep link is assumed.

- [ ] **Step 1: Check in minimal sanitized JSON-RPC fixtures**

Cover initialize, paginated empty/list responses, active/completed/error statuses, protocol error, malformed cursor, disconnect, and a CLI version mismatch. Store only fields the adapter consumes; do not vendor the full generated schema.

- [ ] **Step 2: Implement a bounded app-server client**

Spawn the contract argv above with separate arguments, send JSONL frames with monotonically increasing request IDs, initialize before `thread/list`, follow at most 20 pages/1,000 threads, cap each line at 1 MiB, time out after 3 seconds, and terminate the child on abort. Notifications cannot satisfy pending requests. A later optimization may use `app-server proxy`, but it is outside this milestone and cannot change the adapter contract.

- [ ] **Step 3: Map threads to common records**

Map exact returned thread ID, source-provided title, project/cwd display field, status, and updated timestamp. Unknown status maps to adapter error rather than silently guessing. Mark this source `experimental` in its Studio description until real contract and hardware gates pass.

- [ ] **Step 4: Add the constrained resume action and preset**

Reuse the session launcher with a fixed Codex executable and UUID-validated thread ID. Register `resume-thread(threadId <- id)`. The preset is an ordinary editable dynamic region with no Codex-only renderer.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/sources/codex-app-server.test.ts packages/sources/codex-sessions.test.ts packages/host/src/session-launcher.test.ts packages/studio/presets/codex-sessions.test.ts`

Commit: `feat(sources): add experimental Codex session buttons`

---

### Task 11: Real Session M3 Acceptance

**Files:**
- Create: `packages/sources/session-adapters.integration.test.ts`
- Create: `docs/validation/runtime-session-adapters.md`
- Modify: `README.md`

- [ ] **Step 1: Add installed-CLI contract probes**

The integration test skips with a named reason when a CLI is absent. When present, run version and empty/list probes with the same timeout/output bounds as production and verify records against registered definitions. Never snapshot real titles, prompts, paths, or IDs.

- [ ] **Step 2: Run all automated gates**

Run: `bun test packages/sources/session-adapters.integration.test.ts && bun run check && bun run streamdeck:plugin:check && git diff --check`

- [ ] **Step 3: Perform the user-assisted real-session checklist**

Create at least two Claude and two Codex sessions. Confirm creation, stable slot after update, waiting/done/failed appearance, pagination if needed, exact `attach`/`resume` target, one visible Terminal per press, disappearance after two successful missing memberships, stale preservation during adapter failure, and background restoration.

- [ ] **Step 4: Record compatibility and promote only proven support**

Record macOS, Claude CLI version, Codex CLI version, app-server client version, Stream Deck App/plugin versions, commit, timestamps, and pass/fail. If Codex protocol shape differs, keep its source experimental and record the exact failing contract; do not add scraping fallback.

- [ ] **Step 5: Commit the M3 evidence**

Commit: `test(runtime): approve live session adapters`
