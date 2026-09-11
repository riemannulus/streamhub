# Streamhub Developer Preview Packaging Design

## Goal

Produce a user-installable macOS arm64 preview archive that runs Streamhub Runtime and Studio without the source checkout. The package supports both direct HID and Stream Deck plugin display modes, excludes local user data and credentials, and carries enough metadata to diagnose exactly what was installed.

This is a preview package, not a signed or notarized macOS application. A later release may wrap the same payload in an app and DMG without changing Runtime or Studio ownership rules.

## Supported environment

- Apple Silicon Mac running macOS 13 or newer.
- Bun 1.4.0 available on `PATH`.
- Xcode Command Line Tools, because the current session monitor and system-action helpers compile trusted Swift source on first use.
- A 15-key, 72×72 Stream Deck for HID mode.
- Stream Deck App 7.1 or newer for plugin mode.

The archive is architecture-specific because Sharp and HID use native arm64 dependencies. Intel and cross-platform packages are out of scope for this preview.

## Release identity

The root package gains an explicit preview version. The first artifact is named:

`streamhub-<version>-macos-arm64.tar.gz`

The package manifest records the package version, Git commit, build timestamp, Bun compatibility, target, Studio document schema, plugin version, supported display modes, and checksums. Version and compatibility values come from one validated version module rather than being repeated across scripts.

## Artifact layout

```text
streamhub-<version>-macos-arm64/
  README.md
  DEVELOPMENT.md
  manifest.json
  SHA256SUMS
  install.sh
  uninstall.sh
  bin/
    streamhub
    streamhub-studio
    streamhub-mode-hid
    streamhub-mode-plugin
  app/
    runtime.js
    studio.js
    register-hid.js
    setup-plugin.js
    package.json
    node_modules/
    native/
      session-monitor.swift
  share/
    studio/
      index.html
      app.js
      style.css
      icon-library.css
      display-settings.css
    streamdeck-plugin/
      com.streamhub.studio.sdPlugin/
```

Generated plugin logs, tests, source maps, caches, `.streamhub`, repository history, and development dependencies are forbidden in the artifact.

## Build and assembly

`bun run package` performs these steps in a fresh staging directory:

1. Reject unsupported host architecture or a dirty/invalid version definition.
2. Run the existing Runtime build and build the Studio browser assets ahead of time.
3. Bundle package-specific Runtime, Studio, and mode-selection entry points for Bun.
4. Build the Stream Deck plugin and copy its bundle without runtime logs.
5. Install only production dependencies into the staging payload using the lockfile.
6. Copy user and developer documentation, native helper source, launchers, and safe install scripts.
7. Write a sorted manifest and per-file SHA-256 list.
8. Validate the staged package, create the archive, extract it into a temporary directory, and run read-only smoke checks from outside the repository.

Build output is replaced atomically only after validation succeeds. A failed build must not leave an artifact that looks complete.

## Runtime and Studio launchers

The launchers discover their installed package root from their own real path and invoke the packaged entry point with Bun. They set the default config path to:

`~/Library/Application Support/Streamhub/data/config.json`

Runtime and Studio therefore share one durable user-data directory regardless of the caller's current directory. Explicit `STREAMHUB_CONFIG` continues to override the default for advanced use.

The packaged Studio entry point serves the prebuilt files under `share/studio`; it never tries to compile browser TypeScript at user runtime. The Runtime entry point retains the current single-owner HID/plugin behavior.

## Install and uninstall

`install.sh` is user-scoped and requires no administrator privileges. It installs the immutable payload under:

`~/Library/Application Support/Streamhub/app/<version>`

and creates marked command shims under:

`~/Library/Application Support/Streamhub/bin`

An existing Streamhub preview version may be replaced only when its marker matches. Unknown files and symlinks are refused. Installation never imports the build machine's configuration, Studio document, assets, tokens, icon packs, or device identifiers.

`uninstall.sh` removes only the matching installed payload and marked shims. It preserves `data/`, Studio documents, assets, and plugin credentials, and prints their retained location. Removing user data is a separate explicit manual action documented in the user README.

No launchd service is installed in this preview. Users start Runtime and Studio from a terminal; background login startup belongs to a later packaging milestone.

## Display-mode setup

`streamhub-mode-hid` initializes or updates the installed config to select HID mode. Its output tells the user to quit Stream Deck App before starting Runtime.

`streamhub-mode-plugin` creates the private plugin token and connection file, selects plugin mode, and safely installs the bundled plugin into the current user's Stream Deck plugin directory. If a different existing plugin bundle is present, it is backed up with a timestamp before replacement. The bundled profile uses `AutoInstall`; the user may still need to select it in Stream Deck App and restart that app.

Changing modes remains restart-gated. Setup never silently falls back to the other backend.

## Documentation split

`README.md` becomes user-only documentation:

- What Streamhub does.
- Preview requirements and installation.
- Starting Runtime and Studio.
- Selecting HID or plugin mode.
- Creating pages, backgrounds, standby screens, buttons, icons, labels, and transitions.
- Updating, uninstalling, preserving or explicitly deleting user data.
- Short troubleshooting for port conflicts, HID ownership, plugin connection, accessibility, and Command Line Tools.

`DEVELOPMENT.md` receives all repository-oriented material:

- Source checkout and dependency installation.
- Build, package, test, simulator, and physical validation commands.
- Architecture and trust boundaries.
- Source/collector protocol examples.
- Legacy diagnostic commands and links to design/validation documents.
- Release inspection and package smoke-test procedure.

README may link to DEVELOPMENT.md for contributors but must not teach source-build workflows.

## Validation

Automated tests must prove:

- Manifest parsing rejects missing, unknown, inconsistent, or unsafe values.
- Package assembly includes every required file and excludes credentials, `.streamhub`, logs, tests, and development-only files.
- Launchers resolve paths containing spaces and select the installed data directory.
- Install is repeatable, refuses unowned targets, and never overwrites user data.
- Uninstall removes only marked package files and preserves user data.
- Plugin replacement creates a recoverable backup.
- The extracted Runtime and Studio entry points start from a temporary directory outside the repository.
- Existing `bun run check` and `streamdeck:plugin:check` remain green.

Manual acceptance for this preview is:

1. Extract the archive outside the repository.
2. Install it as the current user.
3. Start Runtime and Studio from the installed shims.
4. Verify HID mode owns the device and preserves the configured standby screen through lock/unlock.
5. Verify plugin mode can be selected and its bundled profile receives a Studio-applied page.
6. Uninstall and confirm the Studio document and credentials remain.

## Explicit non-goals

- `.app`, `.pkg`, or `.dmg` output.
- Apple code signing, hardened runtime, or notarization.
- Automatic login startup or background service installation.
- Intel macOS, Windows, or Linux packages.
- Bundling Bun itself.
- Deleting user data during normal uninstall.
- Shipping the build machine's local Studio state as a default document.
