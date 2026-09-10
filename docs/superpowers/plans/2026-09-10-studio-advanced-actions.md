# Streamhub Studio Advanced Key Behavior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi action, delays, persistent toggles, double press, and hold without weakening the single-action safety guarantees approved at M1.

**Architecture:** Keep the leaf `ButtonAction` union from the core editor and wrap it in non-recursive key behaviors. A pure gesture recognizer converts Stream Deck down/up events into one behavior branch; a cancellable composite executor runs validated leaf actions. Toggle state is Runtime-owned and stored separately from the Studio document.

**Tech Stack:** Bun 1.4, TypeScript 5.9, existing plugin WebSocket input path, atomic JSON persistence.

**Spec:** `docs/superpowers/specs/2026-09-10-studio-core-and-runtime-data-design.md`, section 16 stage 6

## Constraints

- Composite actions contain leaf `ButtonAction` values only; composites cannot contain composites.
- `parallel` means start together and await all results; it does not make non-idempotent actions retryable.
- One physical gesture selects exactly one of press, double press, or hold.
- A page change, generation change, lock, disconnect, or binding revision change aborts pending timers and actions.
- Toggle state changes only after the selected action finishes successfully.
- Studio documents describe behavior; transient timers and persistent toggle values never enter `studio.json`.

---

### Task 1: Non-Recursive Key Behavior Schema

**Files:**
- Modify: `packages/studio/document.ts`
- Modify tests: `packages/studio/document.test.ts`
- Modify: `packages/editor/editing.ts`
- Modify tests: `packages/editor/editing.test.ts`

**Interfaces:**

```ts
export type ActionStep =
  | {type: 'action'; action: ButtonAction}
  | {type: 'delay'; milliseconds: number};

export type ActionSequence = {
  mode: 'sequential' | 'parallel';
  steps: ActionStep[];
};

export type ActionProgram =
  | {type: 'single'; action: ButtonAction}
  | {type: 'sequence'; sequence: ActionSequence}
  | {type: 'toggle'; initial: 'off' | 'on'; offToOn: ActionSequence; onToOff: ActionSequence};

export type KeyBehavior = {
  press?: ActionProgram;
  doublePress?: ActionProgram;
  hold?: ActionProgram;
  doublePressMs: number;
  holdMs: number;
};
```

- `ButtonDefinition.action` becomes `ButtonDefinition.behavior`.
- Core editor-created buttons use `{press:{type:'single', action}, doublePressMs:300, holdMs:500}`.

- [x] **Step 1: Write failing schema tests**

Assert a core single press round-trips. Reject zero branches, nested sequences, more than 16 steps per sequence, delays outside `10..30_000`, parallel delays, page-indicator inside a sequence, `doublePressMs` outside `150..750`, `holdMs` outside `300..2_000`, and `holdMs <= doublePressMs`.

- [x] **Step 2: Run the focused tests**

Run: `bun test packages/studio/document.test.ts packages/editor/editing.test.ts`

Expected: FAIL because `KeyBehavior` is not defined.

- [x] **Step 3: Implement strict cloning and validation**

Reuse `validateButtonAction` for every leaf. Navigation is allowed only as the final sequential action and is rejected in parallel or toggle programs. `none` and `page-indicator` are not executable leaves.

- [x] **Step 4: Update editing transforms**

Copy, duplicate, undo, and paste must structured-clone the whole behavior without sharing a `steps` array. Page reference discovery must inspect every behavior branch and every sequence step.

- [x] **Step 5: Verify and commit**

Run: `bun test packages/studio/document.test.ts packages/editor/editing.test.ts && bun run typecheck`

Commit: `feat(studio): model advanced key behaviors`

---

### Task 2: Cancellable Composite Action Executor

**Files:**
- Create: `packages/actions/composite.ts`
- Create: `packages/actions/composite.test.ts`
- Modify: `packages/host/src/key-actions.ts`
- Modify tests: `packages/host/src/key-actions.test.ts`

**Interfaces:**

```ts
export type ActionResult = {ok:true} | {ok:false; code:string; message:string};

export async function executeProgram(
  program: ActionProgram,
  context: {signal:AbortSignal; run:(action:ButtonAction, signal:AbortSignal)=>Promise<ActionResult>},
): Promise<ActionResult>;
```

- [ ] **Step 1: Write failing scheduler tests with a fake clock**

Test sequential ordering, bounded delays, parallel start order, failure short-circuit for sequential, aggregate failure for parallel, abort during delay, abort during action, and no invocation after cancellation.

- [ ] **Step 2: Run the focused test**

Run: `bun test packages/actions/composite.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement execution without shell strings or retries**

Sequential mode stops on the first error. Parallel mode starts each action exactly once, waits for all started actions, and returns the first result by step order. Delay uses an abortable timer. Never retry an uncertain result.

- [ ] **Step 4: Route leaf actions through the M1 executor**

`key-actions.ts` supplies only the existing `executeButtonAction` callback. Page navigation remains a presentation intent and must not cross into the system action executor.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/actions/composite.test.ts packages/host/src/key-actions.test.ts`

Commit: `feat(actions): execute bounded action sequences`

---

### Task 3: Press, Double-Press, and Hold Recognition

**Files:**
- Create: `packages/streamdeck/gestures.ts`
- Create: `packages/streamdeck/gestures.test.ts`
- Modify: `packages/host/src/presentation.ts`
- Modify tests: `packages/host/src/presentation.test.ts`

**Interfaces:**

```ts
export type Gesture = 'press' | 'double-press' | 'hold';
export type GestureInput =
  | {type:'down'; key:number; bindingRevision:number; at:number}
  | {type:'up'; key:number; bindingRevision:number; at:number}
  | {type:'cancel-all'; reason:string; at:number};

export function createGestureRecognizer(options: {
  schedule:(delayMs:number, callback:()=>void)=>{cancel():void};
  emit:(key:number, revision:number, gesture:Gesture)=>void;
}): {accept(input:GestureInput):void};
```

- [ ] **Step 1: Write a deterministic timing matrix**

Cover press-only immediate release, deferred press when double is configured, two presses inside/outside the window, hold threshold, release after hold, duplicate down/up, out-of-order timestamps, simultaneous different keys, revision replacement, and `cancel-all`.

- [ ] **Step 2: Run the focused test**

Run: `bun test packages/streamdeck/gestures.test.ts`

- [ ] **Step 3: Implement one finite-state machine per key**

If no double branch exists, emit press on key-up. If a double branch exists, defer press until the double window expires. Emit hold once at `holdMs`; the following key-up emits nothing. Discard events whose revision differs from the captured down revision.

- [ ] **Step 4: Connect lifecycle cancellation**

Call `cancel-all` before applying a page/generation change and on lock, plugin disconnect, reconnect, and Runtime shutdown. The presentation service resolves the emitted gesture against the current document before executing it.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/streamdeck/gestures.test.ts packages/host/src/presentation.test.ts`

Commit: `feat(input): recognize advanced key gestures safely`

---

### Task 4: Persistent Toggle State

**Files:**
- Create: `packages/host/src/button-state.ts`
- Create: `packages/host/src/button-state.test.ts`
- Modify: `packages/host/src/runtime.ts`
- Modify tests: `packages/host/src/runtime.test.ts`
- Modify: `packages/presentation/button-compositor.ts`
- Modify tests: `packages/presentation/button-compositor.test.ts`

**Interfaces:**

```ts
export type ButtonStateKey = {documentId:string; pageId:string; buttonId:string};
export interface ButtonStateStore {
  getToggle(key:ButtonStateKey): 'off' | 'on' | undefined;
  setToggle(key:ButtonStateKey, value:'off'|'on'): Promise<void>;
  prune(valid:Set<string>): Promise<void>;
}
```

- [ ] **Step 1: Write persistence and crash-safety tests**

Use a temporary directory. Cover missing file, invalid quarantined file, restart persistence, two rapid updates serialized in order, document reset namespace separation, and pruning deleted buttons.

- [ ] **Step 2: Implement an atomic sidecar store**

Write `.streamhub/button-state.json.tmp`, fsync, and rename to `.streamhub/button-state.json`. Keys are `documentId/pageId/buttonId`; do not store action definitions. Cap entries at 4,096 and reject path-like IDs.

- [ ] **Step 3: Commit toggle changes only after successful execution**

Resolve the current state, execute the matching sequence, then persist the opposite state only for `{ok:true}`. An aborted, failed, or stale action leaves the value unchanged.

- [ ] **Step 4: Expose toggle state to the compositor**

Add `runtime.toggle` to `ComposeButtonInput`; allow the Studio inspector to preview `off` and `on`, but never let preview writes affect Runtime state.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/host/src/button-state.test.ts packages/host/src/runtime.test.ts packages/presentation/button-compositor.test.ts`

Commit: `feat(runtime): persist safe button toggle state`

---

### Task 5: Advanced Behavior Authoring UI

**Files:**
- Create: `packages/editor/web/behavior-editor.ts`
- Create: `packages/editor/web/behavior-editor.test.ts`
- Modify: `packages/editor/web/action-library.ts`
- Modify: `packages/editor/web/inspector-view.ts`
- Modify: `packages/editor/web/style.css`
- Modify: `packages/editor/web/model.ts`
- Modify tests: `packages/editor/web/model.test.ts`

**Interfaces:**
- Adds `여러 동작`, `토글`, `두 번 누르기`, and `길게 누르기` to the basic action group after M1.
- The editor manipulates `KeyBehavior` through model commands; DOM handlers do not mutate arrays directly.

- [ ] **Step 1: Write pure behavior editor tests**

Cover add/remove/reorder step, change sequential/parallel, add delay, configure off/on branches, enable/disable double and hold, threshold validation, and one undo entry per visible edit.

- [ ] **Step 2: Implement a branch-first inspector**

Show tabs `누르기`, `두 번`, `길게`; within the selected branch show single/multiple/toggle. Disable delay in parallel mode and show why. Present navigation-final and 16-step limits before save.

- [ ] **Step 3: Add state previews**

For a toggle button, provide `꺼짐 미리보기` and `켜짐 미리보기`. For gesture branches, preview uses the same base appearance unless the user explicitly configures branch badges; no alternate hidden runtime schema is introduced.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/editor/web/behavior-editor.test.ts packages/editor/web/model.test.ts && bun run typecheck`

Commit: `feat(studio): author advanced key behavior`

---

### Task 6: M2 Integration and Hardware Gate

**Files:**
- Create: `packages/host/src/advanced-actions.integration.test.ts`
- Create: `docs/validation/studio-advanced-actions.md`
- Modify: `README.md`

- [ ] **Step 1: Build an automated gesture-to-effect integration test**

Use a fake plugin clock and fake leaf executor. Verify sequential, parallel, delay, toggle restart persistence, press/double/hold exclusivity, page-change cancellation, lock cancellation, disconnect cancellation, and exactly-once leaf calls.

- [ ] **Step 2: Run all automated gates**

Run: `bun test packages/host/src/advanced-actions.integration.test.ts && bun run check && bun run streamdeck:plugin:check && git diff --check`

- [ ] **Step 3: Perform the user-assisted hardware checklist**

On one test page configure: press/double/hold on one key, a delayed sequence, a parallel sequence, and a persistent toggle. Perform each ten times; record observed branch, duplicate effects, cancellation behavior, and post-Runtime-restart toggle state.

- [ ] **Step 4: Commit the M2 evidence**

Commit: `test(studio): approve advanced key behavior on hardware`
