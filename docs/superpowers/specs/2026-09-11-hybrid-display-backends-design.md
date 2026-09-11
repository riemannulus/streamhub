# Selectable HID and Plugin Display Backends

**Date:** 2026-09-11  
**Status:** Approved design  
**Supersedes:** The plugin-only transport decision in `2026-09-10-streamdeck-plugin-only-architecture-design.md`. The Studio product model, runtime data model, action model, and plugin security decisions in earlier designs remain in force.

## Summary

Streamhub Studio will let the user choose either direct HID ownership or the Stream Deck app plugin as the display backend. The selected mode takes effect only after Streamhub Runtime restarts. A single device is owned by exactly one backend at a time; Streamhub never attempts to mix plugin and HID writes or automatically fail over between them.

Both modes use the same Studio document, runtime signals, page selection, button behavior, action execution, standby appearance, and context routing. Their differences are confined behind a common backend interface:

- HID prioritizes deterministic lifecycle control, smooth transitions, and fast lock recovery.
- Plugin mode prioritizes compatibility with the Stream Deck app, profiles, and the Elgato ecosystem, while exposing its inherent lifecycle and animation limitations honestly.

## Goals

1. Select `HID 직접 연결` or `Stream Deck 앱 플러그인` in Studio.
2. Preserve one Studio document and one behavior model across both modes.
3. Guarantee exclusive physical-device ownership.
4. Make a mode change safe and predictable by applying it only on Runtime restart.
5. Preserve the direct HID path's proven smooth transitions and lock recovery.
6. Preserve the plugin path's authenticated loopback protocol and Stream Deck app integration.
7. Give Studio precise configured, active, connected, and restart-required status.

## Non-goals

- Switching a running device between HID and plugin ownership without restarting Runtime.
- Letting HID take over only for transitions or lock recovery.
- Running both backends against the same physical device.
- Automatically quitting or launching the Stream Deck app.
- Automatically falling back to the other backend after an error.
- Making plugin animations indistinguishable from direct HID.
- Supporting multiple physical Stream Decks in this milestone.

## Core invariant

At most one backend is constructed in a Runtime process. Configuration validation selects one mode before any plugin socket is bound or HID handle is opened. Backend failure leaves that backend selected and reports a recoverable status; it never causes the other backend to acquire the device.

## Architecture

```text
Studio document ─┐
Runtime signals ─┼─> Presentation Coordinator ─> DeckBackend
App/lock context ┤                                  ├─ HidBackend
Button input ────┘                                  └─ PluginBackend
```

The existing plugin-oriented `PresentationService` becomes the transport-independent Presentation Coordinator. It owns:

- Studio repository and asset access
- page composition and routing
- runtime signal projection
- button gestures and action execution
- toggle state
- standby/live selection
- lock and application context
- invalidation of stale prepared presentations

It does not own image wire formats, Stream Deck SDK messages, USB reports, plugin cell readiness, or transport-specific animation scheduling.

## Backend interface

The seam is deliberately small and two-phase:

```ts
type PresentationRequest = {
  reason: 'initial' | 'page' | 'refresh' | 'standby' | 'unlock' | 'reconnect';
  surface: DeckSurface;
  transition: TransitionSpec;
  inputEnabled: boolean;
};

interface PreparedPresentation {
  readonly backend: 'hid' | 'plugin';
  readonly generation: string;
}

interface DeckBackend {
  prepare(request: PresentationRequest): Promise<PreparedPresentation>;
  present(prepared: PreparedPresentation): Promise<void>;
  status(): DeckBackendStatus;
  stop(): Promise<void>;
}
```

`PreparedPresentation` is opaque to the Coordinator. Each adapter validates that a prepared value belongs to itself and has not been superseded. The interface includes these behavioral requirements:

- `prepare` performs expensive rendering/encoding work without making the target visible.
- `present` serializes ownership-sensitive writes and resolves only when the backend's completion contract is satisfied.
- a newer preparation or lifecycle event can invalidate stale work.
- input remains disabled until the exact final destination is committed.
- `stop` is idempotent and releases every resource owned by that backend.

Key events enter the Coordinator through callbacks supplied when constructing the selected adapter. Callbacks include the generation so stale down/up pairs cannot execute after a presentation change.

## Canonical surface

`DeckSurface` is the transport-neutral rendered result: a 480×272 canvas plus the exact fifteen 72×72 key crops and stable presentation identity. It contains no data URI, file path, SDK target, or USB-specific byte layout.

The shared renderer creates the canonical surface once. Adapters may cache derived representations by surface identity:

- HID prepares tightly packed key buffers required by the device library.
- Plugin prepares its bounded key images, local cache entries, and protocol plan.

This keeps visual output and button composition identical without forcing both transports to use the same inefficient encoding.

## HID adapter

The HID adapter reuses `DisplayLifecycle` ownership and cancellation semantics and the existing direct device integration. It changes its input from the legacy `PageConfig` rendering path to canonical `DeckSurface` requests.

The adapter:

- opens exactly one supported 5×3, 72×72-key Stream Deck;
- prepares key buffers before the transition starts;
- paces writes against completed USB operations;
- skips obsolete intermediate deadlines instead of queueing stale frames;
- always sends the exact final frame;
- keeps the latest actually written key buffers as the next transition source;
- writes standby before releasing the device on lock;
- reopens and restores from the prepared unlock presentation;
- disables input across lock, reconnect, transition, and held-key barriers.

If the Stream Deck app owns the device, the adapter reports an actionable unavailable state: `Stream Deck 앱을 완전히 종료한 뒤 Runtime을 다시 시작하세요.` Runtime and Studio remain usable.

## Plugin adapter

The plugin adapter retains the authenticated loopback gateway, profile, persistent cache, cell readiness barrier, and coordinate forwarding. It owns all plugin protocol details and Stream Deck SDK calls.

The adapter:

- precomputes the unlock presentation while locked;
- restores the cached start surface as each action appears;
- waits for all fifteen cells before presenting;
- avoids duplicate unlock and reconnect playback;
- sends intermediate frames to hardware only and the final frame to hardware and software;
- treats SDK promise resolution as request dispatch, not hardware acknowledgement;
- preserves the final exact frame even when intermediate frames are late;
- exposes warming, disconnected, ready, and recovering states.

Plugin frame count, encoding, and file/data-URI strategy remain adapter implementation details. They can be tuned without changing the Coordinator or Studio document. Plugin mode does not claim the same animation or lock-recovery guarantees as HID mode.

## Configuration

The canonical configuration becomes:

```json
{
  "display": {
    "mode": "hid",
    "plugin": {
      "port": 31417,
      "tokenFile": "/absolute/private/path"
    }
  }
}
```

Allowed modes are `hid`, `plugin`, and `off`. `off` preserves headless Runtime, testing, and recovery use cases; Studio's primary choice presents HID and plugin, with disabled output available as a secondary option.

Plugin connection settings remain stored when HID is selected so switching back does not regenerate credentials. HID has no new configuration in this milestone because the supported contract remains exactly one compatible device.

### Legacy migration

Configuration loading normalizes the old flags before validation:

- only `streamdeckPlugin.enabled` → `display.mode = "plugin"`
- only `streamdeck.enabled` → `display.mode = "hid"`
- neither enabled → `display.mode = "off"`
- both enabled → explicit configuration conflict; no backend starts

Existing Studio documents, assets, action definitions, source credentials, plugin token, and stored button state are preserved. The canonical schema is written on the next explicit configuration save; merely reading old configuration does not rewrite the file.

## Runtime startup and shutdown

Runtime startup order is:

1. Read and normalize configuration.
2. Open the signal store and action registry.
3. Construct only the selected backend.
4. Construct the Presentation Coordinator with that backend.
5. Start shared lock and application-context monitors.
6. Start the HTTP server and collectors.

Adapter construction does not acquire the external device or bind the plugin port; connection starts through an internally recoverable initialization step. If that step fails, the selected adapter remains active with `unavailable` status while Runtime continues serving Studio and signal endpoints. A partially acquired handle or socket is released before the status changes. Configuration errors that cannot select exactly one safe adapter still stop startup.

Shutdown stops the Coordinator, shared monitors, the selected backend, server, jobs, and store. No shutdown branch references the unselected backend.

## Presentation flows

### Ordinary page or data change

1. Coordinator renders the destination `DeckSurface`.
2. Coordinator calls `prepare` with the selected motion.
3. Coordinator discards the result if a newer revision superseded it.
4. Coordinator calls `present`.
5. Input becomes eligible only after final presentation completion and held-key release.

### Lock

1. Cancel gestures and running actions.
2. Render, prepare, and present standby with input disabled.
3. Render the latest live destination and prepare the unlock transition without presenting it.
4. Replace that prepared unlock value whenever locked runtime data changes.

### Unlock

1. Revalidate the prepared unlock value against document and signal revision.
2. Prepare synchronously only if the locked preparation is absent or stale.
3. Present the prepared value exactly once.
4. Suppress reconnect presentation until the final unlock presentation completes.
5. Re-enable input after final completion and held-key release.

### Mode change

1. Studio validates and atomically saves the configured mode.
2. Running Runtime and active backend remain unchanged.
3. Studio displays `Runtime 재시작 필요` because configured and active modes differ.
4. User closes the Stream Deck app before starting HID mode, or starts it before using plugin mode.
5. Runtime restart constructs only the newly selected backend.

## Studio experience

The header connection control opens a small device settings panel. It shows:

- configured mode
- active Runtime mode
- connection state and backend-specific explanation
- restart-required state
- two primary mode cards and a secondary `사용 안 함` choice

HID copy emphasizes animation quality and requires the Stream Deck app to be fully closed. Plugin copy emphasizes Stream Deck app/profile compatibility and discloses animation and wake limitations.

Saving mode uses a dedicated authenticated editor endpoint. It is separate from `장치에 적용`, which continues to apply the Studio document. The response includes the saved configured mode and whether it differs from the active Runtime mode.

Studio status distinguishes:

```ts
type StudioDisplayStatus = {
  configuredMode: 'hid' | 'plugin' | 'off';
  activeMode: 'hid' | 'plugin' | 'off';
  state: 'off' | 'connecting' | 'ready' | 'recovering' | 'unavailable';
  restartRequired: boolean;
  message?: string;
};
```

No raw device path, token, local asset path, USB error, or SDK payload is exposed to the browser.

## Error behavior

- Invalid mode requests return a stable 400 response without changing configuration.
- Stale configuration writes return 409 and require Studio reload.
- HID ownership conflict reports the Stream Deck app shutdown instruction.
- Missing or unsupported HID devices report a bounded public error and allow retry only after Runtime restart in this milestone.
- Plugin disconnection remains a waiting state; it does not switch to HID.
- Plugin authentication or configuration failure reports unavailable without exposing secrets.
- A failed presentation keeps input disabled until a later successful presentation.
- Mode-save failure leaves both configured and active modes unchanged.

## Security

- Editor mode changes require the existing per-process editor capability and same-origin checks.
- Plugin token files retain private permissions and absolute-path validation.
- Runtime status exposes only stable public status fields.
- Backend choice never accepts executable paths, device paths, image paths, or shell input from the browser.
- No automatic process termination or launch is performed for the Stream Deck app.

## Testing

### Shared contract

A backend contract suite runs against HID and plugin fakes and verifies preparation, exact final presentation, cancellation, generation gating, input gating, lock preparation, and idempotent stop.

### Configuration and Runtime

- legacy configuration normalization for plugin, HID, and off
- explicit rejection of legacy dual ownership
- construction of exactly one selected adapter
- absence of HID access in plugin mode and plugin socket binding in HID mode
- cleanup after partial startup failure
- configured/active mismatch until restart

### Studio

- authenticated, same-origin mode read and save
- stale-write conflict and atomic preservation
- mode panel rendering and accessible labels
- correct restart warning
- backend-specific help and public errors
- Studio document apply remains independent from mode save

### Lifecycle

The same Coordinator scenarios run with both adapters:

- initial presentation
- page transition
- runtime refresh
- lock to standby
- locked data replacement
- prepared unlock
- reconnect
- held key across lifecycle changes
- cancellation by a newer generation

### Physical acceptance

HID mode must reproduce the previously observed smooth transition and sub-second recovery on the supported device. Plugin mode must restore a correct final screen and actions without duplicate playback; its Stream Deck app wake delay is recorded as an external limitation. Switching modes is verified by restarting Runtime between tests and confirming only the selected owner accesses the device.

## Rollout order

1. Introduce configuration normalization and public display status without changing active behavior.
2. Extract the common Coordinator and backend contract behind the existing plugin path.
3. Adapt direct HID to canonical surfaces and the backend contract.
4. Make Runtime construct exactly one selected backend.
5. Add Studio mode settings and restart-required state.
6. Remove the legacy HID-specific page configuration path after parity tests pass.
7. Run automated regression and physical acceptance for both modes.

## Success criteria

- One Studio document behaves identically in both modes except for documented transport quality differences.
- Runtime never opens plugin and HID ownership for one device in the same process.
- A saved mode does not affect the running backend before restart.
- Restart activates the configured backend and clears the restart warning.
- HID mode retains direct-device transition and lock-recovery quality.
- Plugin mode retains authenticated Stream Deck app integration and exact final output.
- Existing documents, assets, actions, signals, and button state survive migration.
