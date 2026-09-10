# Streamhub Studio Product Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a daily-driver Streamhub Studio by completing ordinary Stream Deck authoring first, then advanced key behavior, Runtime-backed dynamic data, and finally installation, hardware acceptance, and HID removal.

**Architecture:** Four independently reviewable plans share `StudioDocument v3` and the plugin-only presentation path. Each plan ends in a usable vertical milestone; later plans may consume only committed interfaces from earlier plans.

**Tech Stack:** Bun 1.4, TypeScript 5.9, Bun SQLite/HTTP/WebSocket, Sharp 0.34, `@elgato/streamdeck` 2.1.2, macOS launchd and native helpers.

**Spec:** `docs/superpowers/specs/2026-09-10-studio-core-and-runtime-data-design.md`

## Global Constraints

- Stream Deck App remains the sole owner of the physical Stream Deck.
- Product support remains one 5×3 Stream Deck Classic/MK.2-class device.
- Studio preview and Runtime output use the same 480×272 composition path.
- External records cannot choose executables, action names, schemas, or argument validators.
- Input remains blocked across stale bindings, transitions, lock, and reconnect.
- Direct HID remains present but disabled until the final hardware gate passes.
- Every production behavior is test-first and every task ends with an independently reviewable commit.

## Execution Order

1. [Core editor plan](2026-09-10-studio-core-editor.md) — spec stages 1–5
2. [Advanced key behavior plan](2026-09-10-studio-advanced-actions.md) — spec stage 6
3. [Runtime data and sessions plan](2026-09-10-runtime-data-and-sessions.md) — spec stages 7–9
4. [Operations and plugin-only release plan](2026-09-10-operations-and-release.md) — spec stages 10–12

Do not begin a later plan until the prior plan's final gate is committed. The only exception is read-only capability investigation that changes no product files.

## Milestone Gates

| Gate | Required result |
|---|---|
| M1 Core editor | Build `홈`, `웹`, `미디어` from a blank document in ten minutes and operate every single action on hardware |
| M2 Advanced keys | Multi action, toggle, press, double press, and hold execute exactly once without stale effects |
| M3 Dynamic data | Real Claude and Codex sessions appear in stable slots and attach/resume the exact selected ID |
| M4 Daily driver | Login cold start, ten lock cycles, app/runtime/plugin restart, USB reconnect, HID deletion, and 24-hour soak pass |

## Rough Delivery Estimate

Assumption: one engineer working in focused 5–6 hour implementation days, current repository state retained, and the user/device available only at named hardware checkpoints.

| Milestone | Engineering estimate | User/device time |
|---|---:|---:|
| M1 Core editor | 6–9 days | 60–90 minutes |
| M2 Advanced keys | 3–4 days | 30–45 minutes |
| M3 Dynamic data and sessions | 7–10 days | 45–60 minutes |
| M4 Operations and release | 5–7 days plus soak fixes | 24-hour soak and four short recovery sessions |

Total implementation estimate is 21–30 focused engineering days plus the mandatory 24-hour soak. Treat this as scope sizing, not a delivery promise; installed Claude/Codex protocol changes or failed hardware gates restart the affected estimate.

## Critical Path and Stop Conditions

1. Finish and approve M1 before adding multi-action or any data-source UI.
2. Finish M2 before dynamic buttons so all fixed and dynamic buttons share one settled input contract.
3. Prove the generic demo source before connecting Claude or Codex.
4. Keep Codex labeled experimental until the installed app-server contract and real resume test pass.
5. Do not delete direct HID until login, lock, restart, USB, and real-session evidence is committed.
6. Any stale/duplicate action or mixed-generation final frame blocks the next milestone.

## Global Verification

Run after every plan:

```sh
bun run typecheck
bun test
bun run streamdeck:plugin:check
git diff --check
```

Expected: TypeScript exits 0, all Bun tests pass, plugin tests/build pass, and `git diff --check` prints nothing.

## Manual Checkpoints Requiring the User

- Core editor Task 9: visual and action acceptance on the 5×3 device.
- Runtime data Task 8: select real Claude/Codex sessions and confirm exact attach/resume behavior.
- Operations Task 4: ten real lock/unlock cycles.
- Operations Task 5: physical USB disconnect/reconnect.

All other tasks can be executed without physical interaction.
