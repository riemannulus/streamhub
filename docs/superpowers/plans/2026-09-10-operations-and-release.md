# Streamhub Operations and Plugin-Only Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Streamhub recover automatically after login, lock/unlock, process failure, and USB reconnect, then remove direct HID and package only the supported Stream Deck App plugin path.

**Architecture:** A per-user launchd service owns the Runtime while the Stream Deck App owns the device and plugin lifecycle. One diagnostic command checks the entire chain, one setup command installs reversible user-scoped artifacts, and structured acceptance runs produce evidence before direct HID is deleted.

**Tech Stack:** Bun 1.4, TypeScript 5.9, macOS launchd, Stream Deck App plugin/profile, existing session monitor and presentation metrics.

**Spec:** `docs/superpowers/specs/2026-09-10-studio-core-and-runtime-data-design.md`, stages 10–12; `docs/superpowers/specs/2026-09-10-streamdeck-plugin-only-architecture-design.md`

## Constraints

- Setup is user-scoped, idempotent, and reversible; it never needs `sudo`.
- Secrets stay in mode-0600 files under the Streamhub application-support directory and never appear in plist argv, logs, Studio responses, or diagnostics.
- Runtime starts without Studio and keeps operating after Studio closes.
- Stream Deck App remains the only process opening the physical HID device.
- Direct HID is deleted only after cold start, lock, restart, reconnect, and real-session gates pass on the supported device.
- Uncertain key actions are never replayed during recovery.

---

### Task 1: Structured Runtime and Presentation Diagnostics

**Files:**
- Create: `packages/host/src/diagnostics.ts`
- Create: `packages/host/src/diagnostics.test.ts`
- Create: `scripts/doctor.ts`
- Modify: `package.json`
- Modify: `packages/host/src/server.ts`
- Modify tests: `packages/host/src/server.test.ts`

**Interfaces:**

```ts
export type DiagnosticCheck = {
  id:string;
  status:'pass'|'warn'|'fail';
  summary:string;
  remediation?:string;
  durationMs:number;
};
```

- [ ] **Step 1: Write redaction and classification tests**

Cover Runtime offline, invalid config, token file permissions, port conflict, Stream Deck App absent/running, plugin absent/outdated, profile not installed, fewer than 15 cells, plugin disconnected, Runtime transition busy, source error, accessibility permission, and healthy state. Assert tokens, environment values, full source stdout, and record details do not appear.

- [ ] **Step 2: Implement bounded read-only checks**

Each check has a 3-second timeout and returns a stable ID/remediation. `bun run doctor --json` prints the array; default output is concise Korean text. Exit 0 for pass/warn and 1 when any check fails.

- [ ] **Step 3: Expose safe diagnostics to Studio**

Add a server-to-server editor projection of non-sensitive Runtime checks. Studio shows the concrete broken hop: Runtime, Stream Deck App, plugin socket, 15-cell profile, presentation, source, or permission.

- [ ] **Step 4: Verify and commit**

Run: `bun test packages/host/src/diagnostics.test.ts packages/host/src/server.test.ts && bun run doctor --json`

Commit: `feat(ops): diagnose the plugin-only runtime chain`

---

### Task 2: User-Scoped Runtime Service

**Files:**
- Create: `packages/host/src/service-install.ts`
- Create: `packages/host/src/service-install.test.ts`
- Create: `scripts/service.ts`
- Modify: `package.json`
- Modify: `packages/host/src/main.ts`
- Modify tests: `packages/host/src/main.test.ts`

**Installed artifacts:**
- `~/Library/LaunchAgents/com.streamhub.runtime.plist`
- `~/Library/Application Support/Streamhub/runtime/launcher`
- `~/Library/Logs/Streamhub/runtime.log`
- `~/Library/Logs/Streamhub/runtime.error.log`

- [ ] **Step 1: Write plist and idempotency tests in a temporary home**

Assert a fixed absolute launcher path, `RunAtLoad=true`, `KeepAlive` only for non-zero exit, throttling, bounded log paths, no tokens/env dump, mode 0644 plist, mode 0700 directories, identical second install, backup of a differing known plist, and refusal to overwrite a non-Streamhub label/file.

- [ ] **Step 2: Implement a stable launcher**

The launcher resolves the repository/package installation recorded at setup time, then `exec`s the pinned Bun binary with `packages/host/src/main.ts`. It reads normal config/token file paths at Runtime startup; secrets are not embedded in the launcher or plist.

- [ ] **Step 3: Implement install/status/restart/uninstall commands**

Add `bun run service install|status|restart|uninstall`. Use `launchctl bootstrap`, `kickstart`, and `bootout` with separate argv through an injectable process runner. Uninstall removes only files whose label/content marker matches Streamhub and preserves user data/config.

- [ ] **Step 4: Add graceful single-owner behavior**

If the launchd Runtime owns the database/port, manual `bun start` exits with a message pointing to `bun run service status`; it must not kill or replace the service.

- [ ] **Step 5: Verify and commit**

Run: `bun test packages/host/src/service-install.test.ts packages/host/src/main.test.ts && bun run typecheck`

Commit: `feat(ops): run Streamhub Runtime at login`

---

### Task 3: One-Command Setup, Profile Check, and Standby Export

**Files:**
- Replace: `scripts/setup-streamdeck-plugin.ts`
- Replace tests: `scripts/setup-streamdeck-plugin.test.ts`
- Create: `packages/streamdeck-plugin/src/installation.ts`
- Create: `packages/streamdeck-plugin/src/installation.test.ts`
- Create: `packages/studio/standby.ts`
- Create: `packages/studio/standby.test.ts`
- Modify: `packages/editor/web/pages-view.ts`
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Write installation planning tests**

Given fake application-support directories, classify absent/current/outdated plugin, absent/partial/current 15-cell profile, absent/invalid token, Runtime service status, and standby image status. A dry run returns exact creates/updates/backups without writing.

- [ ] **Step 2: Implement idempotent `streamdeck:setup`**

Build the plugin, copy/link the plugin bundle using the supported Stream Deck CLI/install mechanism, generate/retain the mode-0600 token, write connection config, install the 15-cell profile, install the Runtime service, and print only user actions still required in Stream Deck App. Never overwrite a modified profile without a timestamped backup.

- [ ] **Step 3: Implement standby export from the Studio page model**

Render the selected standby page through the same 480×272 background geometry, export the exact image format/dimensions required by Stream Deck App, and show its destination plus a short in-app instruction. Test pixel hash against the same page background compositor used by Runtime.

- [ ] **Step 4: Add setup verification and rollback**

After install, run diagnostic checks and report each hop. If plugin/profile copy fails, leave previous artifacts active and report the backup path. Do not uninstall or stop a previously working Runtime automatically.

- [ ] **Step 5: Verify and commit**

Run: `bun test scripts/setup-streamdeck-plugin.test.ts packages/streamdeck-plugin/src/installation.test.ts packages/studio/standby.test.ts && bun run streamdeck:plugin:check`

Commit: `feat(ops): install Streamhub plugin and standby flow`

---

### Task 4: Lock/Unlock Recovery Benchmark and Gate

**Files:**
- Create: `packages/host/src/recovery-metrics.ts`
- Create: `packages/host/src/recovery-metrics.test.ts`
- Create: `scripts/recovery-report.ts`
- Create: `docs/validation/plugin-lock-recovery.md`
- Modify: `packages/host/src/session-monitor.ts`
- Modify tests: `packages/host/src/session-monitor.test.ts`
- Modify: `packages/host/src/presentation.ts`
- Modify tests: `packages/host/src/presentation.test.ts`

**Measured timeline:**

```text
unlock observed -> input blocked -> first plugin frame sent -> all 15 cells acknowledged -> fade complete -> input enabled
```

- [ ] **Step 1: Write metric aggregation tests**

Cover complete/incomplete samples, monotonic timestamps, p50/p95/max, reason counts, missing acknowledgment, transition superseded, and redacted JSON/Markdown output.

- [ ] **Step 2: Instrument lifecycle edges**

Use one correlation ID per recovery generation. Record monotonic durations only; do not log button labels, record IDs, tokens, or image bytes. A new lock/unlock invalidates the prior sample.

- [ ] **Step 3: Preserve visible animation during recovery**

On unlock, keep input disabled, restore the full page via the existing crossfade/selected transition, and enable input only after all 15 latest-generation cell acknowledgments. If animation exceeds its deadline, keep the last complete frame and expose a diagnostic failure.

- [ ] **Step 4: Run the user-assisted ten-cycle gate**

Run ten real lock/unlock cycles from the launchd service. Record device, firmware, macOS, Stream Deck App/plugin/Runtime versions, selected animation/duration, unlock-to-complete latency, duplicate/missing frames, accepted stale input, and visual discontinuity for every cycle.

- [ ] **Step 5: Apply the release thresholds**

Pass only when: 10/10 restores complete; no stale key action runs; no mixed-generation final frame remains; no Runtime/plugin restart is required; p95 is recorded and accepted by the user against the current 1–2 second Stream Deck App constraint. Do not invent a lower hard latency threshold before real measurement.

- [ ] **Step 6: Verify and commit evidence**

Run: `bun test packages/host/src/recovery-metrics.test.ts packages/host/src/session-monitor.test.ts packages/host/src/presentation.test.ts && bun scripts/recovery-report.ts --check docs/validation/plugin-lock-recovery.md`

Commit: `test(plugin): approve lock recovery on hardware`

---

### Task 5: Process Restart and USB Reconnect Gate

**Files:**
- Create: `packages/streamdeck-plugin/src/recovery.integration.test.ts`
- Create: `scripts/plugin-recovery-check.ts`
- Create: `docs/validation/plugin-restart-and-usb.md`
- Modify: `packages/streamdeck-plugin/src/controller.ts`
- Modify tests: `packages/streamdeck-plugin/src/controller.test.ts`
- Modify: `packages/host/src/plugin-gateway.ts`
- Modify tests: `packages/host/src/plugin-gateway.test.ts`

- [ ] **Step 1: Automate restart-order permutations**

With fake Stream Deck/plugin sockets, test Runtime-first, plugin-first, Runtime restart, plugin restart, Stream Deck App restart, disconnect during frame, reconnect during transition, source update during disconnect, and held key across disconnect. Assert cache handshake, latest generation only, all-15 completion, and required fresh down/up after recovery.

- [ ] **Step 2: Harden bounded reconnect behavior**

Use capped exponential reconnect delay, one socket attempt at a time, generation-aware cached frames, and explicit all-cell synchronization. Never replay key events or queued external actions.

- [ ] **Step 3: Run the user-assisted physical matrix**

Perform Runtime restart, Stream Deck App/plugin restart, USB unplug/replug, and each interruption during a crossfade. Confirm the final page, dynamic record slots, toggle state, no stale action, and recovery without opening Studio or running a repair command.

- [ ] **Step 4: Run automated and documentation checks**

Run: `bun test packages/streamdeck-plugin/src/recovery.integration.test.ts packages/streamdeck-plugin/src/controller.test.ts packages/host/src/plugin-gateway.test.ts && bun scripts/plugin-recovery-check.ts --check docs/validation/plugin-restart-and-usb.md`

- [ ] **Step 5: Commit the recovery evidence**

Commit: `test(plugin): approve restart and USB recovery`

---

### Task 6: Remove Direct HID and Legacy Configuration

**Prerequisite:** Tasks 1–5 and Runtime Data Task 11 are committed and passing. Stop if any hardware evidence file is incomplete.

**Files:**
- Delete: `packages/streamdeck/hid.ts`
- Delete: `packages/streamdeck/hid.test.ts`
- Delete: `packages/streamdeck/diagnostic.ts`
- Delete: `packages/streamdeck/diagnostic.test.ts`
- Delete: `packages/streamdeck/lifecycle.ts`
- Delete: `packages/streamdeck/lifecycle.test.ts`
- Delete: `scripts/hid-check.ts`
- Delete: `scripts/hid-restore.ts`
- Delete: `scripts/hid-lifecycle-check.ts`
- Delete: `scripts/hid-pages-check.ts`
- Modify: `packages/streamdeck/index.ts`
- Modify: `packages/host/src/config.ts`
- Modify tests: `packages/host/src/config.test.ts`
- Modify: `packages/host/src/runtime.ts`
- Modify tests: `packages/host/src/runtime.test.ts`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add a failing forbidden-dependency test**

Create a repository scan test that fails on `@elgato-stream-deck/node`, USB/HID device-open imports, legacy `streamdeck.enabled`, or `hid:*` scripts outside historical documentation.

- [ ] **Step 2: Remove the direct device implementation and dependency**

Delete only the listed direct-HID modules/scripts after confirming `rg` call sites. Remove `@elgato-stream-deck/node` with the package manager so lockfile and manifest stay consistent. Preserve page/render geometry code still used by the plugin path.

- [ ] **Step 3: Collapse configuration to plugin-only**

Reject legacy direct-HID config with an error pointing to the backup/config migration instructions. Keep `streamdeckPlugin`, Studio document, source registry, and presentation settings. Do not silently enable a fallback device owner.

- [ ] **Step 4: Remove obsolete docs and diagnostics**

Make `streamdeck:setup`, `doctor`, service commands, plugin check, and Studio the only supported operating path. Historical ADR/spec files may describe the migration but must be clearly marked non-operational.

- [ ] **Step 5: Verify and commit**

Run: `rg -n "@elgato-stream-deck/node|from ['\"]\.\/hid|hid:(check|restore|lifecycle-check|pages-check)|streamdeck\.enabled" packages scripts package.json README.md`

Expected: no production/config/script matches.

Run: `bun install --frozen-lockfile && bun run check && bun run streamdeck:plugin:check && git diff --check`

Commit: `refactor(streamdeck): remove direct HID support`

---

### Task 7: Reproducible Plugin-Only Package

**Files:**
- Modify: `scripts/build.ts`
- Create: `scripts/package.ts`
- Create: `scripts/package.test.ts`
- Create: `packages/host/src/version.ts`
- Create: `packages/host/src/version.test.ts`
- Modify: `package.json`
- Create: `docs/installation.md`

**Artifact contents:**
- Runtime executable/bundle and native helpers
- `com.streamhub.studio.sdPlugin`
- default 15-cell profile
- setup/service/doctor commands
- license, version manifest, and checksums

- [ ] **Step 1: Write package manifest tests**

Reject absolute build paths, source tokens, `.env`, Studio user documents/assets, logs, SQLite files, HID dependency/code, and unsigned extra executables. Assert normalized mtimes/order and SHA-256 checksums.

- [ ] **Step 2: Produce a clean-install artifact**

Build from a clean checkout into `dist/streamhub-<version>-macos-arm64`. Pin Bun/CLI compatibility in the manifest and include only runtime dependencies. Running package setup must not require the source repository.

- [ ] **Step 3: Add version compatibility reporting**

Runtime, editor, plugin, document schema, source-adapter protocol, and package versions appear in `doctor --json`. A protocol mismatch disables the incompatible source/plugin with an explicit remediation instead of continuing partially.

- [ ] **Step 4: Verify reproducibility and commit**

Run: `bun test scripts/package.test.ts packages/host/src/version.test.ts && bun run package && shasum -a 256 dist/streamhub-*-macos-arm64/manifest.json`

Build twice from the same commit and assert identical file manifests/checksums, excluding the outer archive timestamp.

Commit: `build(release): package plugin-only Streamhub`

---

### Task 8: 24-Hour Daily-Driver Soak and M4 Release Gate

**Files:**
- Create: `scripts/soak-report.ts`
- Create: `scripts/soak-report.test.ts`
- Create: `docs/validation/plugin-only-soak.md`
- Modify: `README.md`

- [ ] **Step 1: Define the bounded soak record**

Collect counts and timings only: uptime, disconnect/reconnect, lock recovery, complete/incomplete frames, action attempts/success/failure/abort, source polls/errors/stale duration, memory samples, and process restarts. Do not record labels, prompts, record IDs, paths, tokens, or action arguments.

- [ ] **Step 2: Write report validator tests**

Require at least 24 elapsed hours, cold login start, at least one lock cycle, one Runtime restart, one Stream Deck App restart, one USB reconnect, one Claude/Codex session lifecycle when installed, zero stale/duplicate actions, zero mixed-generation final frames, and no manual repair command.

- [ ] **Step 3: Install the built artifact and run the soak**

Use the package from Task 7, not the source checkout. Exercise core pages/actions, advanced key behavior, dynamic demo data, and real session adapters during normal use. Log any user-visible issue with timestamp and diagnostic check ID.

- [ ] **Step 4: Resolve failures and restart the full soak window**

Any crash, stale/duplicate action, unrecovered display, data loss, manual repair, or hardware gate regression invalidates the run. Fix in a separate commit, rerun automated gates, reinstall the artifact, and restart the 24-hour window.

- [ ] **Step 5: Approve M4 and commit evidence**

Run: `bun test scripts/soak-report.test.ts && bun scripts/soak-report.ts --check docs/validation/plugin-only-soak.md && bun run check && bun run streamdeck:plugin:check && git diff --check`

Commit: `test(release): approve plugin-only daily-driver build`
