# Headless Simulator Implementation Plan

**Goal:** Run and inspect signal-to-display scenarios while the desktop is locked.

**Architecture:** Reuse `startHost`, `startDisplay`, SQLite, the HTTP server and `HidDisplay`. Replace only physical hardware and native session/context monitors. A CLI drives isolated scenarios and records the actual emitted RGB bytes.

**Tech Stack:** Bun, TypeScript, existing sharp dependency.

**Spec:** The approved conversation design: CLI scenarios, actual host integration, and screen/event artifacts are this iteration. Virtual time, calibrated USB profiles and native OS event capture remain later work.

## Constraints

- Never read user configuration, open real HID, launch native monitors or execute actions.
- Bind real HTTP to an ephemeral loopback port; credentials stay internal.
- Each scenario owns a temporary SQLite directory; restart retains it and final cleanup removes it.
- Observe completed output, not only requested page state. Bounded waits fail with evidence.
- Store RGB updates and standby commands in order, including partial frames.

## Tasks

1. `packages/simulator/host.ts` and `host.test.ts`: inject virtual hardware/OS into the real host; test HTTP, persistence and lock/resume.
2. `packages/simulator/artifacts.ts` and `artifacts.test.ts`: capture key updates, render PNG checkpoints, write JSONL and an offline replay viewer; test exact pixels and safe serialization.
3. `packages/simulator/scenarios.ts`, `scripts/simulator-check.ts`: execute persistence, locked updates, held-key suspension, context/manual selection and interrupted transitions; exit nonzero on failure while preserving artifacts.
4. Add `simulator:check` and usage documentation. Run CLI, inspect a generated PNG, run full checks/build/demo, then get independent review.

## Completion evidence

Record the final commands, scenario outcomes and limitations in `docs/design/headless-simulator.md`. The browser editor remains a lightweight preview in this iteration; the CLI is the integration verification path.
