# Selectable HID and Plugin Display Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Streamhub Studio select a restart-gated HID or Stream Deck plugin display backend while sharing one Studio document, presentation flow, action model, and runtime-data projection.

**Architecture:** Extract the current plugin-oriented presentation orchestration into a transport-independent Coordinator that renders canonical `DeckSurface` values. Put direct USB and Stream Deck SDK behavior behind a small two-phase `DeckBackend` interface; Runtime constructs exactly one Adapter from canonical configuration, and Studio saves the next configured mode without switching the active Adapter.

**Tech Stack:** TypeScript 5.9, Bun 1.4, Sharp 0.34, `@elgato-stream-deck/node` 7.6, `@elgato/streamdeck` 2.1, Bun test, authenticated loopback HTTP/WebSocket.

**Spec:** `docs/superpowers/specs/2026-09-11-hybrid-display-backends-design.md`

## Global Constraints

- One Runtime process constructs at most one physical display Adapter.
- Mode changes are persisted by Studio and take effect only after Runtime restart.
- No live HID/plugin handoff, automatic fallback, or automatic Stream Deck app launch/termination.
- Existing Studio documents, assets, actions, signal data, plugin credentials, and button state survive migration.
- `off` remains a valid headless mode even though HID and plugin are the two primary Studio choices.
- The browser never receives device paths, token paths, credentials, SDK payloads, or raw native errors.
- HID mode supports exactly one 5×3 Stream Deck with fifteen 72×72 LCD keys.
- Plugin mode retains authenticated loopback transport and exact final-frame delivery.
- Every task follows red-green-refactor and ends in a focused commit.

---

## File Structure

### New files

- `packages/presentation/backend.ts` — canonical surface, request, prepared token, status, events, and `DeckBackend` interface.
- `packages/presentation/backend-contract.test.ts` — reusable behavioral contract exercised by Adapter test fakes.
- `packages/host/src/plugin-backend.ts` — host-side Stream Deck app Adapter, including gateway ownership and plugin protocol state.
- `packages/host/src/plugin-backend.test.ts` — plugin preparation, readiness, reconnect, acknowledgement, and shutdown tests.
- `packages/host/src/hid-backend.ts` — direct USB Adapter over the existing lifecycle and HID transport.
- `packages/host/src/hid-backend.test.ts` — direct preparation, pacing, input, ownership failure, and shutdown tests.
- `packages/editor/web/display-settings.ts` — display-mode panel rendering and interaction.
- `packages/editor/web/display-settings.test.ts` — pure mode-copy, restart-state, and selection tests.
- `packages/editor/web/display-settings.css` — accessible mode-panel layout and restart banner.

### Major modified files

- `packages/presentation/render.ts` — return canonical binary key crops rather than transport data URIs.
- `packages/host/src/presentation.ts` — become the transport-independent Presentation Coordinator.
- `packages/host/src/runtime.ts` — construct exactly one configured Adapter and shared monitors.
- `packages/host/src/config.ts` — canonical display configuration and legacy normalization.
- `packages/streamdeck/hid.ts` — accept already-composed key surfaces and preserve direct-write timing.
- `packages/streamdeck/lifecycle.ts` — generalize serialized ownership from legacy `DeckPage` to prepared display work.
- `packages/editor/server.ts` — authenticated mode-save endpoint and configured/active status projection.
- `packages/editor/web/state.ts` — display settings state and save operation.
- `packages/editor/web/app.ts` and `index.html` — open and refresh the display settings panel.
- `scripts/setup-streamdeck-plugin.ts` and `scripts/register-streamdeck.ts` — write canonical plugin/HID mode.

### Removed after parity

- `packages/host/src/display.ts` — duplicated legacy HID orchestration, replaced by the Coordinator plus `HidBackend`.
- `packages/host/src/display.test.ts` — scenarios move to Coordinator and Adapter tests.

---

### Task 1: Canonical Display Configuration and Legacy Normalization

**Files:**
- Modify: `packages/host/src/config.ts`
- Modify: `packages/host/src/config.test.ts`
- Modify: `scripts/setup-streamdeck-plugin.ts`
- Modify: `scripts/setup-streamdeck-plugin.test.ts`
- Modify: `scripts/register-streamdeck.ts`

**Interfaces:**
- Produces: `DisplayMode`, `DisplayConfig`, `configuredDisplay(config)`, and normalized `Config.display`.
- Preserves temporarily: legacy `streamdeck` and `streamdeckPlugin` fields so intermediate commits continue to compile; Task 8 removes them from canonical output.

- [ ] **Step 1: Write failing canonical and migration tests**

Add tests that pin all four legacy outcomes and canonical validation:

```ts
test('normalizes exactly one legacy display owner without losing plugin credentials',()=>{
  const plugin=validateConfig({...base,streamdeck:{enabled:false},streamdeckPlugin:{enabled:true,port:31417,tokenFile:'/private/token'}});
  expect(configuredDisplay(plugin)).toEqual({mode:'plugin',plugin:{port:31417,tokenFile:'/private/token'}});

  const hid=validateConfig({...base,streamdeck:{enabled:true}});
  expect(configuredDisplay(hid).mode).toBe('hid');

  const off=validateConfig(base);
  expect(configuredDisplay(off).mode).toBe('off');
});

test('rejects ambiguous legacy dual ownership',()=>{
  expect(()=>validateConfig({...base,streamdeck:{enabled:true},streamdeckPlugin:{enabled:true,port:31417,tokenFile:'/private/token'}}))
    .toThrow('Display ownership is ambiguous');
});

test('accepts canonical display mode and rejects unknown mode fields',()=>{
  expect(configuredDisplay(validateConfig({...base,display:{mode:'hid'}})).mode).toBe('hid');
  expect(configuredDisplay(validateConfig({...base,display:{mode:'plugin',plugin:{port:31417,tokenFile:'/private/token'}},streamdeck:{enabled:true}})).mode).toBe('plugin');
  expect(()=>validateConfig({...base,display:{mode:'automatic'}})).toThrow('Invalid display config');
});
```

- [ ] **Step 2: Run the configuration tests and verify RED**

Run: `bun test packages/host/src/config.test.ts scripts/setup-streamdeck-plugin.test.ts`

Expected: FAIL because `display` and `configuredDisplay` do not exist and dual legacy ownership is currently accepted.

- [ ] **Step 3: Add canonical types and one normalization function**

Implement these exact public types and accessor:

```ts
export type DisplayMode='off'|'hid'|'plugin';
export type DisplayConfig={
  mode:DisplayMode;
  plugin?:{port:number;tokenFile:string};
};

export function configuredDisplay(config:Config):DisplayConfig{
  return structuredClone(config.display);
}
```

Normalize before the rest of `validateConfig` executes. When canonical `display` is present it is authoritative; during the transitional commits, derive mutually exclusive legacy enable flags from it so the old Runtime cannot construct both owners. When canonical `display` is absent, exactly one enabled legacy owner maps to its mode, neither maps to `off`, and two enabled owners throw `Display ownership is ambiguous`. Preserve the legacy board and plugin credentials while validating plugin port, absolute token path, private-file validation at Runtime startup, and exact known keys.

- [ ] **Step 4: Make setup commands write the selected canonical mode**

`setup-streamdeck-plugin.ts` must preserve the private token, write the canonical selection, and explicitly disable the transitional HID flag:

```ts
return{
  ...config,
  display:{mode:'plugin',plugin:{port:31417,tokenFile:result.tokenFile}},
  streamdeck:{...config.streamdeck,enabled:false},
  streamdeckPlugin:{enabled:true,port:31417,tokenFile:result.tokenFile},
};
```

`register-streamdeck.ts` becomes the HID selection command, writes the canonical selection, and explicitly disables the transitional plugin flag:

```ts
return{
  ...config,
  display:{...config.display,mode:'hid'},
  streamdeck:{...config.streamdeck,enabled:true},
  streamdeckPlugin:config.streamdeckPlugin&&{...config.streamdeckPlugin,enabled:false},
};
```

Neither command starts or stops an application or device.

- [ ] **Step 5: Run focused and full validation**

Run: `bun test packages/host/src/config.test.ts scripts/setup-streamdeck-plugin.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: PASS with the transitional legacy fields still available.

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/config.ts packages/host/src/config.test.ts scripts/setup-streamdeck-plugin.ts scripts/setup-streamdeck-plugin.test.ts scripts/register-streamdeck.ts
git commit -m "feat(config): select one display backend"
```

---

### Task 2: Canonical Binary Deck Surface

**Files:**
- Create: `packages/presentation/backend.ts`
- Create: `packages/presentation/backend-contract.test.ts`
- Modify: `packages/presentation/render.ts`
- Modify: `packages/presentation/render.test.ts`
- Modify: `packages/host/src/presentation.ts`
- Modify: `packages/host/src/presentation.test.ts`

**Interfaces:**
- Consumes: `TransitionSpec` from `packages/studio/document.ts`.
- Produces: `DeckSurface`, `PresentationRequest`, `PreparedPresentation`, `DeckBackendStatus`, `DeckBackendEvents`, and `DeckBackend`.

- [ ] **Step 1: Write failing canonical-surface and backend-contract tests**

Pin binary crops and the small two-phase interface:

```ts
test('renderer returns one identified canvas and fifteen transport-neutral PNG crops',async()=>{
  const surface=await renderer.render(document,page,deck,assets);
  expect(surface.identity).toMatch(/^[a-f0-9]{64}$/);
  expect(surface.png).toBeInstanceOf(Buffer);
  expect(surface.keyPngs).toHaveLength(15);
  expect(surface.keyPngs.every(key=>Buffer.isBuffer(key))).toBe(true);
  expect(surface).not.toHaveProperty('keys');
});

export async function exerciseBackendContract(create:()=>DeckBackend){
  const backend=create();
  const prepared=await backend.prepare(request('g1'));
  expect(prepared).toMatchObject({generation:'g1'});
  await backend.present(prepared);
  await backend.stop();
  await expect(backend.stop()).resolves.toBeUndefined();
}
```

Expand the reusable contract around an injected sink and event recorder. It must assert: `prepare` is visually silent except for backend-defined unlock caching, only the newest unpresented token remains valid, `present` reaches the exact destination before resolving, a newer preparation cancels obsolete intermediate work, keys are suppressed until final completion and then carry the committed generation, lock preparation does not enable input, status never leaks native errors, and repeated `stop` is safe. Both concrete Adapter test files call this exported contract with their own fakes in Tasks 3 and 5.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun test packages/presentation/render.test.ts packages/presentation/backend-contract.test.ts packages/host/src/presentation.test.ts`

Expected: FAIL because rendered keys are data URI strings and the backend module is absent.

- [ ] **Step 3: Define the transport-neutral interface**

Create `packages/presentation/backend.ts` with these signatures:

```ts
export type DeckBackendKind='hid'|'plugin';
export type PresentationReason='initial'|'page'|'refresh'|'standby'|'unlock'|'reconnect';
export type DeckSurface={identity:string;png:Buffer;keyPngs:readonly Buffer[]};
export type PresentationRequest={
  generation:string;
  reason:PresentationReason;
  from?:DeckSurface;
  to:DeckSurface;
  transition:TransitionSpec;
  inputEnabled:boolean;
};
export type PreparedPresentation=Readonly<{backend:DeckBackendKind;generation:string;token:string}>;
export type DeckBackendStatus={
  mode:DeckBackendKind;
  state:'connecting'|'ready'|'recovering'|'unavailable';
  connected:boolean;
  message?:string;
};
export type DeckBackendEvents={
  key(event:{index:number;phase:'down'|'up';generation:string}):void;
  ready():void;
};
export interface DeckBackend{
  prepare(request:PresentationRequest):Promise<PreparedPresentation>;
  present(prepared:PreparedPresentation):Promise<void>;
  status():DeckBackendStatus;
  stop():Promise<void>;
}
```

Document that `DeckSurface.identity` is the lowercase SHA-256 digest of the exact final canvas bytes. Document that `token` is opaque, adapter-scoped, bounded to 64 URL-safe characters, and never exposed outside Runtime.

- [ ] **Step 4: Return binary key crops from the renderer**

Rename the old `DeckCanvas` result to `DeckSurface`, return `keyPngs: Buffer[]`, compute `identity` after final composition, and remove URI conversion from `render.ts`. Keep plugin URI conversion temporarily inside `presentation.ts` so this commit preserves behavior.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `bun test packages/presentation/render.test.ts packages/presentation/backend-contract.test.ts packages/host/src/presentation.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/presentation/backend.ts packages/presentation/backend-contract.test.ts packages/presentation/render.ts packages/presentation/render.test.ts packages/host/src/presentation.ts packages/host/src/presentation.test.ts
git commit -m "refactor(presentation): introduce canonical deck surfaces"
```

---

### Task 3: Plugin Backend Adapter

**Files:**
- Create: `packages/host/src/plugin-backend.ts`
- Create: `packages/host/src/plugin-backend.test.ts`
- Modify: `packages/host/src/plugin-gateway.ts`
- Modify: `packages/host/src/plugin-gateway.test.ts`
- Modify: `packages/presentation/transitions.ts`
- Modify: `packages/presentation/protocol.ts`
- Modify: `packages/host/src/presentation.ts`

**Interfaces:**
- Consumes: `DeckBackend`, `DeckBackendEvents`, `PresentationRequest`, `TransitionCompiler`, `PluginGateway`.
- Produces: `startPluginBackend(options): Promise<DeckBackend>` and no gateway/protocol knowledge in the Coordinator.

- [ ] **Step 1: Write failing Adapter tests**

Invoke `exerciseBackendContract` with an injected gateway fake, then add plugin-specific assertions that ordinary preparation remains invisible, unlock preparation is advertised without playback, and presentation is exact:

```ts
test('plugin backend prepares invisibly and presents its opaque token once',async()=>{
  const sent:RuntimeToPluginMessage[]=[];
  const backend=await startPluginBackend({
    gateway:fakeGateway(sent),events,
    compiler:new TransitionCompiler(40),
  });
  const prepared=await backend.prepare(request({generation:'g1',reason:'page'}));
  expect(sent).toEqual([]);
  await backend.present(prepared);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({type:'presentation',delivery:'immediate',plan:{generation:'g1'}});
});

test('plugin backend advertises locked unlock preparation and resumes it after readiness',async()=>{
  const prepared=await backend.prepare(request({generation:'g2',reason:'unlock'}));
  expect(sent.at(-1)).toMatchObject({delivery:'prepare',inputEnabled:false});
  gateway.receive({v:1,type:'cells-ready',deviceId:'deck'});
  await backend.present(prepared);
  expect(sent.at(-1)).toMatchObject({delivery:'resume',plan:{generation:'g2'}});
});
```

Also test wrong-backend tokens, superseded tokens, final `frame-sent`, key forwarding with generation, reconnect readiness, status sanitization, and idempotent stop.

Add a bind/authentication initialization failure test proving `startPluginBackend` resolves to an Adapter with `state:'unavailable'`, releases any partially opened gateway, reports only a bounded public message, and never throws a native socket error through Runtime startup.

- [ ] **Step 2: Run Adapter tests and verify RED**

Run: `bun test packages/host/src/plugin-backend.test.ts packages/host/src/plugin-gateway.test.ts`

Expected: FAIL because `startPluginBackend` does not exist.

- [ ] **Step 3: Move compilation and protocol publication into `PluginBackend`**

The Adapter keeps a bounded map from opaque token to internal prepared data:

```ts
type PluginPrepared={request:PresentationRequest;plan:FramePlan;startKeys:readonly string[];advertised:boolean};
  const prepared=new Map<string,PluginPrepared>();
```

Generate tokens with `randomUUID().replaceAll('-','')`, invalidate every older unpresented token when a new one is prepared, reject a token whose `backend !== 'plugin'`, and delete a consumed token after `present` starts. Convert `DeckSurface.keyPngs` to data URIs only inside this Adapter.

- [ ] **Step 4: Make the Adapter own plugin messages and readiness**

Move handling for `cells-ready`, `key`, `frame-sent`, connection loss, unlock/reconnect suppression, current generation, and public status out of `presentation.ts`. The gateway remains a narrow authenticated transport and calls the Adapter's internal message handler.

`ready()` events request a Coordinator reconnect only when no unlock recovery is active. `frame-sent` clears recovery only when generation and final index match.

- [ ] **Step 5: Keep protocol limits and exact final delivery**

Retain the current 15-frame bound, PNG/JPEG data-URI validation, hardware-only intermediate target, and PNG final target. This task preserves current plugin behavior; file-path optimization is independent and stays outside the hybrid ownership migration.

- [ ] **Step 6: Run plugin and protocol validation**

Run: `bun test packages/host/src/plugin-backend.test.ts packages/host/src/plugin-gateway.test.ts packages/presentation/protocol.test.ts packages/presentation/transitions.test.ts packages/streamdeck-plugin/src`

Expected: PASS.

Run: `bun run streamdeck:plugin:check`

Expected: PASS and regenerate `packages/streamdeck-plugin/com.streamhub.studio.sdPlugin/bin/plugin.js` only if protocol code changed.

- [ ] **Step 7: Commit**

```bash
git add packages/host/src/plugin-backend.ts packages/host/src/plugin-backend.test.ts packages/host/src/plugin-gateway.ts packages/host/src/plugin-gateway.test.ts packages/presentation/transitions.ts packages/presentation/protocol.ts packages/host/src/presentation.ts packages/streamdeck-plugin/com.streamhub.studio.sdPlugin/bin/plugin.js
git commit -m "refactor(plugin): isolate the display backend adapter"
```

---

### Task 4: Transport-independent Presentation Coordinator

**Files:**
- Modify: `packages/host/src/presentation.ts`
- Modify: `packages/host/src/presentation.test.ts`
- Modify: `packages/host/src/advanced-actions.integration.test.ts`
- Modify: `packages/presentation/backend-contract.test.ts`

**Interfaces:**
- Consumes: one injected `DeckBackend` and `DeckBackendEvents` callbacks.
- Produces: `startPresentationCoordinator(options): Promise<PresentationCoordinator>`.

- [ ] **Step 1: Replace gateway-shaped tests with a fake Backend**

Define a deterministic fake that records the common interface rather than plugin messages:

```ts
class FakeBackend implements DeckBackend{
  requests:PresentationRequest[]=[];
  presented:string[]=[];
  async prepare(request:PresentationRequest){
    this.requests.push(structuredClone(request));
    return{backend:'plugin' as const,generation:request.generation,token:`p${this.requests.length}`};
  }
  async present(value:PreparedPresentation){this.presented.push(value.generation);}
  status(){return{mode:'plugin' as const,state:'ready' as const,connected:true};}
  async stop(){}
}
```

Pin initial, page, refresh, action result, lock, locked data replacement, unlock, stale preparation, reconnect, and held-key sequences. The lock test must assert standby is presented first, unlock is prepared but not presented, and unlock presents the same prepared generation exactly once.

- [ ] **Step 2: Run Coordinator tests and verify RED**

Run: `bun test packages/host/src/presentation.test.ts packages/host/src/advanced-actions.integration.test.ts`

Expected: FAIL because the current service consumes plugin messages and owns `TransitionCompiler`.

- [ ] **Step 3: Introduce the Coordinator interface**

Use these public operations:

```ts
export type PresentationCoordinator={
  key(event:{index:number;phase:'down'|'up';generation:string}):Promise<void>;
  locked(value:boolean):Promise<void>;
  backendReady():Promise<void>;
  context(context:PageContext,now?:number):Promise<void>;
  refresh(reason?:PresentationReason):Promise<void>;
  apply(document:StudioDocument,expectedVersion:string):Promise<StudioSnapshot>;
  snapshot():StudioSnapshot;
  status():DeckBackendStatus&{generation?:string;locked:boolean};
  stop():Promise<void>;
};
```

Rename `startPresentationService` to `startPresentationCoordinator`. Remove protocol parsing, gateway publication, image URI conversion, and plugin acknowledgement handling from this file.

- [ ] **Step 4: Implement one generation-safe render pipeline**

For ordinary changes:

```ts
const target=await renderLive();
const request={generation:nextGeneration(),reason,from:current,to:target,transition,inputEnabled:!locked};
const prepared=await backend.prepare(request);
if(ticket!==publicationTicket)return;
await backend.present(prepared);
current=target;
currentGeneration=request.generation;
```

Increment `publicationTicket` before every lifecycle change so a slow render or preparation cannot publish after lock, document replacement, or a newer refresh.

- [ ] **Step 5: Implement shared two-phase lock recovery**

On lock, present standby and then retain one prepared unlock value. While locked, store revision changes replace that value. On unlock, reuse it only when document revision, signal revision, and lifecycle ticket still match; otherwise prepare once synchronously. Ignore repeated equal lock values.

- [ ] **Step 6: Preserve action and input semantics**

Route Adapter key events through the existing gesture recognizer. Require exact current generation, unlocked state, and existing key. Preserve cancellation, toggle persistence, safe program execution, page navigation, and post-action refresh behavior.

- [ ] **Step 7: Run Coordinator and action validation**

Run: `bun test packages/host/src/presentation.test.ts packages/host/src/advanced-actions.integration.test.ts packages/actions packages/streamdeck/gestures.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/host/src/presentation.ts packages/host/src/presentation.test.ts packages/host/src/advanced-actions.integration.test.ts packages/presentation/backend-contract.test.ts
git commit -m "refactor(runtime): share presentation coordination across backends"
```

---

### Task 5: Direct HID Backend Adapter

**Files:**
- Create: `packages/host/src/hid-backend.ts`
- Create: `packages/host/src/hid-backend.test.ts`
- Modify: `packages/streamdeck/hid.ts`
- Modify: `packages/streamdeck/hid.test.ts`
- Modify: `packages/streamdeck/lifecycle.ts`
- Modify: `packages/streamdeck/lifecycle.test.ts`

**Interfaces:**
- Consumes: canonical `DeckSurface`, `DeckBackend`, and `DeckBackendEvents`.
- Produces: `startHidBackend(options): Promise<DeckBackend>`.

- [ ] **Step 1: Write failing HID Adapter tests**

Invoke `exerciseBackendContract` with a fake hardware handle, then add HID-specific assertions over completed writes and emitted keys:

```ts
test('HID backend prepares RGB before presentation and finishes on the exact destination',async()=>{
  const hardware=new FakeHardware();
  const backend=await startHidBackend({connect:async()=>hardware,events});
  const prepared=await backend.prepare(request({generation:'g1',reason:'page'}));
  expect(hardware.writes).toEqual([]);
  await backend.present(prepared);
  expect(hardware.writes.at(-1)).toEqual(exactDestinationRgb);
  expect(backend.status()).toMatchObject({mode:'hid',state:'ready',connected:true});
});

test('HID ownership conflict is public and never starts plugin fallback',async()=>{
  const backend=await startHidBackend({connect:async()=>{throw Object.assign(new Error('LIBUSB_ERROR_ACCESS'),{code:'LIBUSB_ERROR_ACCESS'});},events});
  await expect(backend.present(await backend.prepare(request()))).resolves.toBeUndefined();
  expect(backend.status()).toMatchObject({state:'unavailable',connected:false,message:'Stream Deck 앱을 완전히 종료한 뒤 Runtime을 다시 시작하세요.'});
});
```

Also pin deadline skipping, exact final write, interrupted-transition source, standby-before-close, key generation, held-key release, unsupported geometry, and idempotent stop.

- [ ] **Step 2: Run HID tests and verify RED**

Run: `bun test packages/host/src/hid-backend.test.ts packages/streamdeck/hid.test.ts packages/streamdeck/lifecycle.test.ts`

Expected: FAIL because canonical surfaces cannot enter the legacy HID path.

- [ ] **Step 3: Generalize serialized display ownership**

Change `DisplayLifecycle` to accept a generic prepared work item with explicit identity rather than importing `DeckPage`:

```ts
export type DisplayWork={identity:string};
export type DisplayDevice<T extends DisplayWork>={
  write(work:T,signal:AbortSignal):Promise<void>;
  standby():Promise<void>;
  close():Promise<void>;
};
export class DisplayLifecycle<T extends DisplayWork>{/* existing serialized state machine */}
```

Preserve every existing timeout, late-open cleanup, abort, held-key, retry, standby, and stop invariant. Update existing lifecycle tests before changing production callers.

- [ ] **Step 4: Accept precomposed HID frames**

Define the HID-internal work shape:

```ts
export type HidPresentation={
  identity:string;
  generation:string;
  from?:readonly Buffer[];
  to:readonly Buffer[];
  transition:TransitionSpec;
};
```

`HidDisplay.write` receives exactly fifteen tightly packed 72×72 RGB buffers. Remove `renderKey` and `DeckPage` knowledge from `HidDisplay`; `HidBackend.prepare` uses Sharp to convert canonical PNG crops to RGB before storing the opaque token.

- [ ] **Step 5: Preserve every direct HID transition and its pacing**

Keep completed USB operations as the pacing signal and compile frames directly from prepared RGB buffers:

- `none`: write only the exact destination;
- `crossfade`: linearly blend the latest actually written source into the destination at four intermediate deadlines, then write the exact destination;
- `fade-through-black`: blend the source to black for the first half and black to the destination for the second half at four intermediate deadlines, then write the exact destination.

Treat either animated type with `durationMs:0` as `none`. Skip late intermediate work, retain each actually completed buffer as the source for an interrupted transition, and abort immediately on supersession. Do not route HID frames through `TransitionCompiler`, base64, files, JSON, or the Stream Deck SDK. Add pixel-level tests for the midpoint and final frame of both animated transition types so a future optimization cannot collapse them into the same effect.

For a `standby` request, complete the exact standby write and then close the HID handle. A subsequent locked `unlock` preparation performs only PNG-to-RGB conversion and keeps the prepared value in memory; it must not enumerate or open USB. `present` on unlock reopens the device, plays from the standby buffers, and reports `ready` only after the exact destination write completes.

- [ ] **Step 6: Map native failures to bounded status**

Map access/busy ownership failures to the Stream Deck app shutdown instruction. Map zero devices to `Stream Deck을 찾지 못했습니다.` and unsupported geometry to `5×3 Stream Deck만 지원합니다.` Log the original error only on the local Runtime error channel.

`startHidBackend` must resolve to an Adapter even when the initial open fails. That Adapter remains selected with `state:'unavailable'`, releases any partially acquired handle, accepts prepared work without exposing native errors, and does not attempt plugin fallback. A later Runtime restart is the only retry path in this milestone.

- [ ] **Step 7: Run HID and contract validation**

Run: `bun test packages/host/src/hid-backend.test.ts packages/streamdeck/hid.test.ts packages/streamdeck/lifecycle.test.ts packages/presentation/backend-contract.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/host/src/hid-backend.ts packages/host/src/hid-backend.test.ts packages/streamdeck/hid.ts packages/streamdeck/hid.test.ts packages/streamdeck/lifecycle.ts packages/streamdeck/lifecycle.test.ts packages/presentation/backend-contract.test.ts
git commit -m "feat(display): adapt direct HID to Studio surfaces"
```

---

### Task 6: Runtime Exclusive Backend Ownership and Public Status

**Files:**
- Modify: `packages/host/src/runtime.ts`
- Modify: `packages/host/src/runtime.test.ts`
- Modify: `packages/host/src/server.ts`
- Modify: `packages/host/src/server.test.ts`
- Modify: `packages/host/src/main.test.ts`
- Modify: `packages/host/src/plugin-backend.ts`
- Modify: `packages/host/src/hid-backend.ts`

**Interfaces:**
- Consumes: `Config.display`, `startPresentationCoordinator`, `startHidBackend`, `startPluginBackend`.
- Produces: one active Adapter and sanitized `StudioDisplayStatus` through Runtime endpoints.

- [ ] **Step 1: Write failing ownership-selection tests**

Inject separate factories and assert exact construction counts:

```ts
test.each(['hid','plugin','off'] as const)('constructs only the %s display owner',async mode=>{
  const calls={hid:0,plugin:0};
  const runtime=await startHost(config(mode),directory,{dependencies:{
    hidBackend:async()=>{calls.hid++;return fakeBackend('hid');},
    pluginBackend:async()=>{calls.plugin++;return fakeBackend('plugin');},
  }});
  expect(calls).toEqual(mode==='hid'?{hid:1,plugin:0}:mode==='plugin'?{hid:0,plugin:1}:{hid:0,plugin:0});
  await runtime.stop();
});
```

Add a test that a selected Adapter's unavailable status does not construct the other Adapter, and a cleanup test for a partially initialized selected Adapter.

- [ ] **Step 2: Run Runtime tests and verify RED**

Run: `bun test packages/host/src/runtime.test.ts packages/host/src/server.test.ts packages/host/src/main.test.ts`

Expected: FAIL because Runtime independently starts legacy plugin and HID branches.

- [ ] **Step 3: Replace parallel startup branches with one mode switch**

Use one local variable `backend: DeckBackend | undefined` and one `coordinator: PresentationCoordinator | undefined`:

```ts
switch(config.display.mode){
  case'hid':backend=await factories.hidBackend(/* events */);break;
  case'plugin':backend=await factories.pluginBackend(/* events and credentials */);break;
  case'off':break;
}
if(backend)coordinator=await startPresentationCoordinator({store,directory:studioDirectory,backend,...});
```

Use callback holders so Adapter construction can receive `key` and `ready` callbacks before `coordinator` is assigned. Dropped pre-assignment callbacks must be harmless and must not be replayed.

- [ ] **Step 4: Start shared monitors once**

Start session and application-context monitors only when a Coordinator exists. Route callbacks to `coordinator.locked` and `coordinator.context`. Remove plugin-specific monitor ownership and the legacy HID display monitor branch.

- [ ] **Step 5: Expose sanitized configured and active state**

Return this exact public shape from `/v1/state` and `/v1/studio`:

```ts
type StudioDisplayStatus={
  configuredMode:DisplayMode;
  activeMode:DisplayMode;
  state:'off'|'connecting'|'ready'|'recovering'|'unavailable';
  restartRequired:boolean;
  message?:string;
};
```

For a running process, `activeMode` is fixed at startup. Runtime reports `restartRequired:false`; the editor combines this active value with the latest file-backed configured mode after a Studio mode save.

- [ ] **Step 6: Preserve cleanup ordering**

Stop monitors, Coordinator, selected Adapter, server, jobs, and store exactly once. The unselected factory and cleanup path must never run. Preserve AggregateError collection and startup cancellation semantics.

- [ ] **Step 7: Run Runtime integration validation**

Run: `bun test packages/host/src/runtime.test.ts packages/host/src/server.test.ts packages/host/src/main.test.ts packages/host/src/presentation.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/host/src/runtime.ts packages/host/src/runtime.test.ts packages/host/src/server.ts packages/host/src/server.test.ts packages/host/src/main.test.ts packages/host/src/plugin-backend.ts packages/host/src/hid-backend.ts
git commit -m "feat(runtime): enforce one selected display owner"
```

---

### Task 7: Studio Display Mode Settings

**Files:**
- Create: `packages/editor/web/display-settings.ts`
- Create: `packages/editor/web/display-settings.test.ts`
- Create: `packages/editor/web/display-settings.css`
- Modify: `packages/editor/server.ts`
- Modify: `packages/editor/server.test.ts`
- Modify: `packages/editor/web/state.ts`
- Modify: `packages/editor/web/state.test.ts`
- Modify: `packages/editor/web/app.ts`
- Modify: `packages/editor/web/index.html`
- Modify: `packages/editor/web/style.css`

**Interfaces:**
- Consumes: file-backed configured mode, Runtime active status, config version, existing editor capability.
- Produces: `StudioState.setDisplayMode(mode)` and `openDisplaySettings(state,onChanged,onError)`.

- [ ] **Step 1: Write failing authenticated endpoint tests**

Pin bootstrap projection, successful save, stale conflict, invalid mode, and absence of secrets:

```ts
test('display mode save changes configuration but not active Runtime mode',async()=>{
  const boot=await editorJson('/api/bootstrap');
  expect(boot.display).toMatchObject({configuredMode:'plugin',activeMode:'plugin',restartRequired:false});
  const saved=await editorJson('/api/display-mode',{method:'POST',body:{mode:'hid',expectedVersion:boot.configVersion}});
  expect(saved.display).toMatchObject({configuredMode:'hid',activeMode:'plugin',restartRequired:true});
  expect(JSON.stringify(saved)).not.toContain('tokenFile');
});
```

Requests without `X-Streamhub-Editor`, with cross-site origin, wrong content type, unknown fields, invalid mode, or stale version must leave configuration byte-for-byte unchanged.

- [ ] **Step 2: Run server tests and verify RED**

Run: `bun test packages/editor/server.test.ts packages/editor/web/state.test.ts packages/editor/web/display-settings.test.ts`

Expected: FAIL because display bootstrap and save do not exist.

- [ ] **Step 3: Add the dedicated mode-save endpoint**

`GET /api/bootstrap` returns `configVersion` plus sanitized display status. `POST /api/display-mode` accepts exactly:

```ts
{mode:'off'|'hid'|'plugin',expectedVersion:string}
```

Use the existing atomic `updateConfig` and whole-config hash conflict check. Preserve plugin settings while changing only `display.mode`. Query Runtime only for active status; a Runtime request failure yields `activeMode:'off'`, `state:'unavailable'`, and the existing offline explanation without changing configuration.

- [ ] **Step 4: Add Studio state without coupling it to document dirty state**

Add:

```ts
display:StudioDisplayStatus;
async setDisplayMode(mode:DisplayMode):Promise<void>;
```

Mode save updates `configVersion` and `display` but never calls `model.changed`, never writes `draft.json`, and never enables the document `장치에 적용` button.

- [ ] **Step 5: Build the settings panel**

The header Runtime status becomes a button opening a modal panel with:

- `HID 직접 연결` — `가장 부드러운 화면 전환. Stream Deck 앱을 완전히 종료해야 합니다.`
- `Stream Deck 앱 플러그인` — `Elgato 앱과 프로필을 사용합니다. 잠금 복구와 애니메이션에는 제한이 있습니다.`
- secondary `사용 안 함`
- configured mode, active mode, connection state, public message
- `Runtime 재시작 필요` banner when modes differ
- `취소` and `설정 저장` buttons

Use a native `<dialog>`, labeled radio inputs, Escape close, focus return, and no automatic app/process actions.

- [ ] **Step 6: Test pure view decisions**

Keep copy/state logic testable without a browser:

```ts
expect(displayModeCopy('hid').warning).toContain('완전히 종료');
expect(displayModeCopy('plugin').warning).toContain('제한');
expect(restartRequired({configuredMode:'hid',activeMode:'plugin'})).toBe(true);
expect(restartRequired({configuredMode:'hid',activeMode:'hid'})).toBe(false);
```

- [ ] **Step 7: Run Studio validation**

Run: `bun test packages/editor/server.test.ts packages/editor/web/state.test.ts packages/editor/web/display-settings.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/editor/server.ts packages/editor/server.test.ts packages/editor/web/display-settings.ts packages/editor/web/display-settings.test.ts packages/editor/web/display-settings.css packages/editor/web/state.ts packages/editor/web/state.test.ts packages/editor/web/app.ts packages/editor/web/index.html packages/editor/web/style.css
git commit -m "feat(studio): select the restart-gated display mode"
```

---

### Task 8: Remove Legacy HID Orchestration and Canonicalize Saved Configuration

**Files:**
- Delete: `packages/host/src/display.ts`
- Delete: `packages/host/src/display.test.ts`
- Modify: `packages/host/src/config.ts`
- Modify: `packages/host/src/config.test.ts`
- Modify: `packages/host/src/runtime.ts`
- Modify: `packages/editor/server.ts`
- Modify: `packages/editor/server.test.ts`
- Modify: `packages/simulator/host.ts`
- Modify: `packages/simulator/host.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: complete Coordinator, HID Adapter, plugin Adapter, and canonical `Config.display`.
- Produces: one canonical persisted configuration schema with read-only legacy normalization.

- [ ] **Step 1: Move remaining legacy scenarios to the shared path**

Before deletion, port the unique assertions from `display.test.ts` to Coordinator/HID integration tests: context routing, manual page pinning, fixed effect success/failure, monitor cleanup, pending action cancellation, and healthy-data recovery. Each moved test must call the common Studio document Adapter rather than `PageConfig`-specific `applyDraft`.

- [ ] **Step 2: Run moved tests and verify behavior parity**

Run: `bun test packages/host/src/presentation.test.ts packages/host/src/hid-backend.test.ts packages/host/src/advanced-actions.integration.test.ts`

Expected: PASS with every retained legacy scenario named in the new files.

- [ ] **Step 3: Delete duplicate legacy orchestration**

Delete `packages/host/src/display.ts` and its test after `rg "startDisplay|applyDraft" packages scripts` shows no production caller. Keep reusable `PageBoard`, gestures, lifecycle, HID transport, renderer primitives, and simulator code.

- [ ] **Step 4: Write only canonical configuration on explicit saves**

Remove legacy fields from the exported `Config` type and serialized output. Keep a private raw-input normalizer that recognizes old `streamdeck` and `streamdeckPlugin` keys only while loading. After `updateConfig`, serialized JSON must contain `display` and must not contain either legacy key.

Add a test that begins with a legacy file, calls one explicit mode save, preserves plugin credentials and Studio-related configuration, and writes canonical keys once.

- [ ] **Step 5: Remove production dependence on legacy board configuration**

Runtime uses the Studio repository for both display modes. Keep simulator-only `PageConfig` fixtures inside simulator modules; remove `/api/config` production board saving if no current Studio caller remains. Update tests to use `/api/apply` for Studio documents.

- [ ] **Step 6: Update operator documentation**

Document:

```text
HID mode: quit the Stream Deck app, select HID in Studio, restart Runtime.
Plugin mode: start the Stream Deck app, select Plugin in Studio, restart Runtime.
Mode changes never take effect before restart and never fall back automatically.
```

Remove documentation that describes the old independent enable flags or legacy HID page configuration as the current path.

- [ ] **Step 7: Run the complete automated gate**

Run: `bun run check`

Expected: all repository tests pass with zero failures.

Run: `bun run streamdeck:plugin:check`

Expected: all plugin tests, typecheck, asset generation, and bundling pass.

- [ ] **Step 8: Commit**

```bash
git add packages/host/src/display.ts packages/host/src/display.test.ts packages/host/src/config.ts packages/host/src/config.test.ts packages/host/src/runtime.ts packages/editor/server.ts packages/editor/server.test.ts packages/simulator/host.ts packages/simulator/host.test.ts README.md
git commit -m "refactor(display): retire duplicate legacy HID orchestration"
```

---

### Task 9: Restart Semantics and Physical Acceptance

**Files:**
- Modify: `packages/host/src/runtime.test.ts`
- Modify: `packages/editor/server.test.ts`
- Modify: `scripts/hid-lifecycle-check.ts`
- Create: `scripts/display-mode-check.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: canonical configuration, Studio mode endpoint, both production Adapters.
- Produces: `bun run display:check --mode hid|plugin` and final acceptance evidence.

- [ ] **Step 1: Write failing restart-boundary tests**

Pin a full two-process model with injected factories:

```ts
test('saved mode remains inactive until the next Runtime instance',async()=>{
  const first=await startHost(config('plugin'),directory,{dependencies});
  await saveMode('hid');
  expect(await runtimeDisplay(first)).toMatchObject({configuredMode:'plugin',activeMode:'plugin'});
  await first.stop();
  const second=await startHost(readConfig(),directory,{dependencies});
  expect(await runtimeDisplay(second)).toMatchObject({configuredMode:'hid',activeMode:'hid'});
  await second.stop();
});
```

The editor-level test separately proves `configuredMode:'hid'`, `activeMode:'plugin'`, and `restartRequired:true` before restart.

- [ ] **Step 2: Run restart tests and verify RED if any status is derived from the wrong source**

Run: `bun test packages/host/src/runtime.test.ts packages/editor/server.test.ts`

Expected before final correction: FAIL if Runtime rereads configured mode during status calls or Studio loses active mode.

- [ ] **Step 3: Add a bounded physical check command**

`scripts/display-mode-check.ts` must:

- require `--mode hid` or `--mode plugin`;
- read the configured mode without printing credentials;
- refuse when requested and configured mode differ;
- query Runtime public display status with the local admin token but print only sanitized status;
- show one exact operator instruction when the Stream Deck app must be started or stopped;
- wait for user Enter before one lock/unlock observation window;
- poll `/v1/state` every 25 ms and record observation start, first `recovering` state, and the next `ready` state;
- use a 1,000 ms HID bound and a 3,000 ms plugin bound from observation start to the next `ready` state;
- rely on each Adapter's `recovering → ready` contract—`ready` is emitted only after the exact final HID write or matching final plugin `frame-sent` acknowledgement;
- exit nonzero when recovery never starts or ready is not observed inside the selected bound.

Add `"display:check":"bun scripts/display-mode-check.ts"` to `package.json`.

- [ ] **Step 4: Run complete automated verification**

Run: `bun run check`

Expected: all tests pass.

Run: `bun run streamdeck:plugin:check`

Expected: all plugin checks pass and the bundle is current.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: Perform HID physical acceptance**

1. Select `HID 직접 연결` in Studio.
2. Stop Runtime and fully quit the Stream Deck app.
3. Start Runtime.
4. Run `bun run display:check --mode hid`.
5. Verify the configured and active modes are both HID.
6. Trigger page forward/back and confirm a smooth exact final canvas.
7. Lock and unlock macOS ten times.
8. Repeat the check ten times; record median, p95, and maximum observed ready times, and confirm no intermediate profile flash and sub-second recovery on the supported device.
9. Press one fixed app button and one dynamic session button; confirm one exact action each.

- [ ] **Step 6: Perform plugin physical acceptance**

1. Select `Stream Deck 앱 플러그인` in Studio.
2. Stop Runtime and start the Stream Deck app.
3. Start Runtime.
4. Run `bun run display:check --mode plugin`.
5. Verify the configured and active modes are both plugin.
6. Confirm all fifteen cells appear and the exact final canvas is restored.
7. Lock and unlock macOS three times and confirm no duplicate Streamhub playback; record the Stream Deck app wake delay as external.
8. Press the same fixed and dynamic buttons; confirm equivalent action behavior.

- [ ] **Step 7: Record acceptance results in README**

Add the tested device model, Stream Deck app version, macOS version, HID timings, plugin timings, known plugin wake limitation, and exact commands used. Do not claim plugin parity with HID animation quality.

- [ ] **Step 8: Commit**

```bash
git add packages/host/src/runtime.test.ts packages/editor/server.test.ts scripts/hid-lifecycle-check.ts scripts/display-mode-check.ts package.json README.md
git commit -m "test(display): verify restart-gated backend selection"
```

---

## Final Verification

- [ ] `bun run check` passes with zero failures.
- [ ] `bun run streamdeck:plugin:check` passes and regenerates no unexpected files.
- [ ] `git diff --check` prints nothing.
- [ ] `rg "streamdeckPlugin|streamdeck\.enabled" packages scripts README.md` finds only the private legacy input normalizer and migration tests.
- [ ] Studio displays configured mode, active mode, connection state, and restart warning without secrets.
- [ ] Saving a mode does not change the current Adapter or document dirty state.
- [ ] Restart constructs only the configured Adapter.
- [ ] HID physical acceptance preserves smooth animation and fast recovery.
- [ ] Plugin physical acceptance preserves exact output and one playback while documenting the external wake limitation.
