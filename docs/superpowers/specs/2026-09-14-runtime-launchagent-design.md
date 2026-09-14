# Runtime LaunchAgent Design

**Date:** 2026-09-14

**Status:** Approved direction

**Target:** Streamhub `0.1.0-preview.1`, Apple Silicon macOS 13+

## Goal

Let an installed Streamhub Runtime run without occupying a terminal and start automatically at login, while preserving the existing foreground `streamhub start` workflow for development and diagnosis. Studio remains an explicitly launched foreground process and is never started by the Runtime service.

## User Experience

The packaged commands have these responsibilities:

```text
./install.sh                         Install program files only
streamhub setup [hid|plugin]         Select the display owner only
streamhub start                      Run Runtime in the foreground
streamhub daemon enable              Enable login start and start Runtime now
streamhub daemon disable             Stop Runtime and disable login start
streamhub daemon restart             Restart an enabled Runtime service
streamhub daemon status              Show bounded service and display state
streamhub daemon logs [--follow]     Read the Runtime service log
streamhub studio [--no-open]         Run Studio in the foreground
streamhub uninstall                  Disable the service and remove the app
```

`daemon enable` is explicit. A fresh `./install.sh` and `streamhub setup` never start a background process or change login behavior. `daemon disable` means both “stop now” and “do not start at the next login.” Studio continues to stop with Ctrl-C and has no LaunchAgent.

If the Runtime LaunchAgent is loaded, `streamhub start` refuses before opening the database or device and tells the user to run `streamhub daemon disable`. This makes foreground and service ownership mutually exclusive.

## Why LaunchAgent

Three approaches were considered:

1. A detached child with a PID file is small but does not survive login reliably and makes stale PID recovery the application’s responsibility.
2. A user LaunchAgent gives macOS-owned login start, crash restart, signal delivery, and process identity without administrator privileges. This is the selected approach.
3. Serving Studio from Runtime would remove another process but would merge separate HTTP capability and security boundaries. It is outside this change.

## Service Model

Streamhub manages exactly one label:

```text
com.streamhub.runtime
```

The generated plist lives at:

```text
~/Library/LaunchAgents/com.streamhub.runtime.plist
```

It contains absolute paths for:

- the Bun executable used by `streamhub daemon enable`;
- the installed `app/runtime.ts` entry point;
- `STREAMHUB_CONFIG` under `~/Library/Application Support/Streamhub/data/config.json`;
- the installed package as the working directory; and
- the Runtime log under `~/Library/Application Support/Streamhub/data/logs/runtime.log`.

The job uses `RunAtLoad=true` and restarts after an unsuccessful exit. A graceful `daemon disable` first removes the job from the user’s launchd domain, so its successful termination is not restarted. It never uses `sudo`, a system daemon, a shell command, relative paths, inherited project environment, or a PID file.

All `launchctl` operations target the current user domain `gui/<uid>` and the exact service label. The implementation invokes `/bin/launchctl` with literal argv. `enable` performs an idempotent bootstrap or replaces an outdated owned definition; `restart` uses a launchd kickstart only for an enabled job; `disable` is idempotent when no owned job or definition exists.

The plist includes a stable Streamhub ownership comment. Before replacement or deletion, Streamhub rejects symlinks, non-regular files, a missing ownership marker, a different label, or arguments outside the expected installed Streamhub root. The generated plist is validated with `plutil` before publication and written atomically with user-only permissions.

## Runtime and Studio Boundaries

Only Runtime is registered with launchd. It owns data ingestion, state, selected HID or Plugin backend, button execution, lock lifecycle, and the existing port 31415 API.

Studio remains the existing loopback-only foreground server on port 31416:

```sh
streamhub studio
```

The command opens the browser unless `--no-open` is supplied and holds that terminal until Ctrl-C. Closing Studio has no effect on Runtime. Login, Runtime crash recovery, `daemon enable`, and `daemon restart` never open Studio or a browser.

## Display Mode Behavior

`streamhub setup hid|plugin` changes only the saved display mode. When the daemon is enabled, setup reports that `streamhub daemon restart` is required; it does not restart automatically.

HID login start requires the Stream Deck app not to claim the device at login. Documentation tells HID users to disable the Stream Deck app’s login launch. Plugin mode allows the Stream Deck app to own the device and the Runtime waits for the plugin connection through the existing backend behavior. No mode fallback is added.

## Status and Logs

The existing top-level `streamhub status` remains a bounded display/API status command. `streamhub daemon status` adds only:

- `enabled`: whether the owned LaunchAgent definition is installed;
- `loaded`: whether launchd currently knows the job;
- `running`: whether launchd reports a process;
- `pid` when launchd provides a positive integer;
- `lastExitStatus` when launchd provides a bounded integer; and
- the existing sanitized display status when Runtime answers.

It never prints plist contents, environment variables, tokens, config contents, device paths, command arguments, or raw launchctl output.

`streamhub daemon logs` reads the exact managed log and prints a bounded recent tail. `--follow` follows that one regular file until Ctrl-C. It rejects symlinks and never accepts an arbitrary path. The log directory remains user data and survives uninstall. The log is rolled to one previous file when the service starts and the existing log exceeds 5 MiB; a single running process may exceed that threshold before its next restart.

## Install, Update, and Uninstall

A fresh `./install.sh` installs program files and the `streamhub` command only. It does not create a plist.

When replacing an installed package while the owned LaunchAgent is enabled, installation:

1. records that the service was enabled;
2. unloads it before replacing program files;
3. installs and validates the new marked payload;
4. regenerates the plist with the new absolute paths; and
5. bootstraps the service again.

If package publication or service restoration fails, installation restores the prior owned payload, plist, and enabled state. It never adopts or modifies a foreign plist.

`streamhub uninstall` unloads the owned job and removes the owned plist before deleting the installed package and command link. If the service cannot be unloaded safely, uninstall stops and leaves the program in place. Configuration, Studio documents and assets, SQLite state, plugin credentials, and Runtime logs remain under the data directory.

## Failure Handling

- Missing Bun, launchctl, or plutil produces an actionable error without partial registration.
- Foreign or linked plist files are never overwritten or removed.
- A bootstrap failure restores the prior owned definition when possible and reports a sanitized error.
- `daemon restart` on a disabled service explains that `daemon enable` is required.
- A foreground start while the service is loaded performs no Runtime side effect.
- Runtime crash loops remain visible through `daemon status` and the bounded log; launchd throttles restarts.
- HID ownership failure remains HID failure and does not start Plugin mode.

## Implementation Boundaries

A release service module owns plist generation, validation, launchctl invocation, state normalization, log access, and update coordination behind injected filesystem and process dependencies. The public CLI only parses commands and delegates. Installer code calls the same service module, so interactive commands and update/uninstall cannot drift.

No service code is added to the Runtime domain itself. The Runtime continues to handle SIGTERM through its existing graceful shutdown path. No global daemon, `.app`, privileged helper, PID file, shell-evaluated command, Studio autostart, or cross-platform service abstraction is introduced.

## Verification

Automated tests cover:

- strict command parsing and side-effect-free rejection;
- deterministic plist escaping and exact arguments;
- ownership, symlink, permissions, and atomic-write checks;
- enable, repeated enable, disable, repeated disable, restart, and sanitized status with a fake launchctl runner;
- foreground start refusal while the service is loaded;
- bounded and follow log behavior without arbitrary path access;
- installer update rollback and enabled-state restoration;
- uninstall ordering and user-data preservation;
- package allowlist and extracted archive smoke tests.

Physical acceptance on the user account covers Plugin and HID enable, login cold start, foreground conflict guidance, restart, disable, update while enabled, uninstall, and confirmation that Studio never opens automatically. HID acceptance also verifies the Stream Deck app is not configured to launch and claim the device first.
