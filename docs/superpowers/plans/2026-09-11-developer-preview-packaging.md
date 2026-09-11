# Streamhub Developer Preview Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and document a user-scoped macOS arm64 preview archive that runs Runtime and browser-based Studio through one `streamhub` command without the source checkout.

**Architecture:** Bundle the three executable entry points (CLI, Runtime, Studio) for Bun, prebuild browser assets, and stage them with production native dependencies and the Stream Deck plugin. A release module owns version/manifest validation, a setup module owns display-mode changes and plugin installation, and an installer module owns the marked user-scoped copy/symlink lifecycle. The public shell files are thin relocatable launchers; all safety-sensitive behavior remains testable TypeScript.

**Tech Stack:** Bun 1.4.0, TypeScript 5.9, Bun.build, Bun.spawn, Sharp 0.34, `@elgato-stream-deck/node` 7.6.3, `@elgato/streamdeck` 2.1.2, POSIX shell, macOS arm64.

**Spec:** `docs/superpowers/specs/2026-09-11-developer-preview-packaging-design.md`

## Global Constraints

- Target only Apple Silicon macOS 13 or newer for `0.1.0-preview.1`.
- Require Bun 1.4.0 on `PATH`; do not bundle Bun.
- Require Xcode Command Line Tools for first-use Swift helper compilation.
- Support `off`, `hid`, and `plugin`; never fall back between HID and plugin.
- Install without administrator privileges under `~/Library/Application Support/Streamhub/app/<version>`.
- Expose only `~/.local/bin/streamhub`; never edit shell startup files.
- Store config and Studio data under `~/Library/Application Support/Streamhub/data` unless `STREAMHUB_CONFIG` is explicitly supplied.
- Never package `.streamhub`, credentials, user Studio assets, plugin logs, tests, source maps, Git data, or development dependencies.
- Uninstall preserves user data and plugin credentials unless the user separately removes them.
- Do not add launchd, `.app`, DMG, signing, notarization, Intel, Windows, or Linux work.
- Use TDD for production behavior and commit after every task.

---

### Task 1: Release identity and manifest contract

**Files:**
- Create: `packages/release/version.ts`
- Create: `packages/release/version.test.ts`
- Create: `packages/release/manifest.ts`
- Create: `packages/release/manifest.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `packageVersion: string`, `releaseTarget: 'macos-arm64'`, `ReleaseManifest`, `createReleaseManifest(input)`, and `validateReleaseManifest(input)`.
- Consumes: root `package.json` version and the bundled plugin manifest version.

- [ ] **Step 1: Write failing version and manifest tests**

```ts
test('release identity is one validated macOS arm64 preview version',()=>{
  expect(packageVersion).toBe('0.1.0-preview.1');
  expect(releaseTarget).toBe('macos-arm64');
});

test('manifest exposes bounded compatibility and rejects unknown fields',()=>{
  const manifest=createReleaseManifest({gitCommit:'a'.repeat(40),builtAt:'2026-09-11T00:00:00.000Z',pluginVersion:'0.2.0.0'});
  expect(manifest).toEqual({formatVersion:1,name:'streamhub',version:'0.1.0-preview.1',target:'macos-arm64',gitCommit:'a'.repeat(40),builtAt:'2026-09-11T00:00:00.000Z',bun:'1.4.0',studioSchema:3,pluginVersion:'0.2.0.0',displayModes:['off','hid','plugin']});
  expect(()=>validateReleaseManifest({...manifest,token:'secret'})).toThrow('manifest');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test packages/release/version.test.ts packages/release/manifest.test.ts`

Expected: FAIL because the release modules and root version do not exist.

- [ ] **Step 3: Implement the identity and strict manifest**

```ts
import metadata from '../../package.json';
export const releaseTarget='macos-arm64' as const;
export const packageVersion=metadata.version;
if(!/^0\.1\.0-preview\.1$/.test(packageVersion))throw new Error('Invalid Streamhub package version');
```

`validateReleaseManifest` must require exactly the fields shown by the test, validate the 40-character lowercase Git hash and ISO timestamp, clone the modes array, and reject extra properties.

- [ ] **Step 4: Add the root version and run GREEN**

Add `"version": "0.1.0-preview.1"` beside the root package name.

Run: `bun test packages/release/version.test.ts packages/release/manifest.test.ts && bun run typecheck`

Expected: all release tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json packages/release/version.ts packages/release/version.test.ts packages/release/manifest.ts packages/release/manifest.test.ts
git commit -m "feat(release): define preview package identity"
```

---

### Task 2: Safe display setup and plugin installation

**Files:**
- Create: `packages/release/setup.ts`
- Create: `packages/release/setup.test.ts`
- Modify: `scripts/setup-streamdeck-plugin.ts`
- Modify: `scripts/register-streamdeck.ts`

**Interfaces:**
- Consumes: `updateConfig`, `setupPluginFiles`, package root, explicit home/application-support paths, and the built `com.streamhub.studio.sdPlugin` directory.
- Produces: `setupDisplayMode(options:{mode:'hid'|'plugin';packageRoot:string;applicationSupport:string;now?:()=>Date}):Promise<SetupResult>` where `SetupResult` contains only mode, public guidance, and optional backup path.

- [ ] **Step 1: Write failing setup tests**

```ts
test('HID setup changes only the canonical mode',async()=>{
  const result=await setupDisplayMode(fixture({mode:'hid'}));
  expect(readConfig().display).toEqual({mode:'hid',plugin:existingPlugin});
  expect(result.guidance).toContain('Stream Deck 앱을 완전히 종료');
});

test('plugin setup installs a clean bundle and backs up a different owned bundle',async()=>{
  const result=await setupDisplayMode(fixture({mode:'plugin',now:()=>new Date('2026-09-11T01:02:03Z')}));
  expect(result.backupPath).toEndWith('com.streamhub.studio.sdPlugin.20260911T010203Z.backup');
  expect(existsSync(join(pluginTarget,'logs'))).toBe(false);
  expect(readConfig().display.mode).toBe('plugin');
  expect(statSync(connectionToken).mode&0o777).toBe(0o600);
});
```

Also test missing package bundle, symlinked plugin target, invalid existing token, and a second identical setup. Use temporary explicit paths; never touch the real Stream Deck directory.

- [ ] **Step 2: Run the setup tests and verify RED**

Run: `bun test packages/release/setup.test.ts`

Expected: FAIL because `setupDisplayMode` does not exist.

- [ ] **Step 3: Implement setup with explicit boundaries**

```ts
export type SetupResult={mode:'hid'|'plugin';guidance:string;backupPath?:string};
export async function setupDisplayMode(options:SetupOptions):Promise<SetupResult>{
  if(options.mode==='hid'){
    options.updateConfig(config=>({...config,display:{...config.display,mode:'hid'}}));
    return{mode:'hid',guidance:'Stream Deck 앱을 완전히 종료한 뒤 streamhub start를 실행하세요.'};
  }
  // Validate source/target containment, back up a different owned bundle,
  // copy without logs, prepare the private token, then select plugin mode.
}
```

Refactor the two existing scripts to call the shared setup function so source-checkout and packaged behavior cannot drift.

- [ ] **Step 4: Run setup and config regression tests**

Run: `bun test packages/release/setup.test.ts scripts/setup-streamdeck-plugin.test.ts packages/host/src/config.test.ts && bun run typecheck`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/release/setup.ts packages/release/setup.test.ts scripts/setup-streamdeck-plugin.ts scripts/register-streamdeck.ts
git commit -m "feat(release): install preview display modes safely"
```

---

### Task 3: Single user CLI and prebuilt Studio entry point

**Files:**
- Create: `packages/release/cli.ts`
- Create: `packages/release/cli.test.ts`
- Create: `scripts/preview-cli.ts`
- Create: `scripts/packaged-studio.ts`
- Create: `scripts/packaged-studio.test.ts`
- Create: `packaging/bin/streamhub`

**Interfaces:**
- Consumes: Task 1 version values, Task 2 `setupDisplayMode`, packaged root/config paths, Runtime and Studio entry files.
- Produces: `parsePreviewCommand(argv):PreviewCommand`, `runPreviewCommand(command,deps):Promise<number>`, and `startPackagedStudio(options):Promise<EditorHandle>`.

- [ ] **Step 1: Write failing parser and side-effect boundary tests**

```ts
test('CLI accepts only documented commands and options',()=>{
  expect(parsePreviewCommand(['setup','hid'])).toEqual({type:'setup',mode:'hid'});
  expect(parsePreviewCommand(['studio','--no-open'])).toEqual({type:'studio',open:false});
  for(const argv of [[],['wat'],['start','extra'],['studio','--bad'],['setup','off']])expect(()=>parsePreviewCommand(argv)).toThrow('Usage');
});

test('unknown commands perform no process, browser, config, or uninstall effects',async()=>{
  await expect(main(['wat'],effects)).resolves.toBe(2);
  expect(effects.calls).toEqual([]);
});
```

For Studio, build fixture static files, start on port 0 with an injected browser opener, fetch `/`, and assert `open` is called once only when enabled.

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `bun test packages/release/cli.test.ts scripts/packaged-studio.test.ts`

Expected: FAIL because the parser and packaged Studio entry point are missing.

- [ ] **Step 3: Implement the CLI dispatcher**

```ts
export type PreviewCommand=
  |{type:'setup';mode?:'hid'|'plugin'}
  |{type:'start'}|{type:'studio';open:boolean}
  |{type:'status'}|{type:'version'}|{type:'uninstall'};

export async function runPreviewCommand(command:PreviewCommand,deps:PreviewDependencies){
  switch(command.type){
    case 'start': return deps.runChild(deps.runtimeEntry,[]);
    case 'studio': return deps.runChild(deps.studioEntry,command.open?[]:['--no-open']);
    case 'status': return deps.printStatus(await deps.status());
    // setup/version/uninstall use their bounded dependencies.
  }
}
```

Status must return only `configuredMode`, `activeMode`, `state`, `restartRequired`, and bounded public guidance. Never print config JSON, tokens, plugin token paths, environment, or HID paths.

- [ ] **Step 4: Implement packaged Studio and relocatable shell launcher**

`scripts/packaged-studio.ts` reads `STREAMHUB_PACKAGE_ROOT/share/studio`, starts `startEditorServer`, and invokes `/usr/bin/open` with the exact loopback URL unless `--no-open` is present. It installs the same SIGINT/SIGTERM cleanup as `scripts/editor.ts`.

`packaging/bin/streamhub` resolves symlinks and paths containing spaces, sets `STREAMHUB_PACKAGE_ROOT`, supplies the installed default config only when the caller did not set one, then `exec`s `bun app/cli.js` with literal arguments.

- [ ] **Step 5: Run GREEN and regressions**

Run: `bun test packages/release/cli.test.ts scripts/packaged-studio.test.ts packages/editor/server.test.ts && bun run typecheck`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/release/cli.ts packages/release/cli.test.ts scripts/preview-cli.ts scripts/packaged-studio.ts scripts/packaged-studio.test.ts packaging/bin/streamhub
git commit -m "feat(release): expose one preview command"
```

---

### Task 4: Marked user-scoped installer and preserving uninstall

**Files:**
- Create: `packages/release/install.ts`
- Create: `packages/release/install.test.ts`
- Create: `scripts/preview-install.ts`
- Create: `packaging/install.sh`
- Create: `packaging/uninstall.sh`

**Interfaces:**
- Consumes: validated Task 1 manifest, extracted package root, optional explicit `--prefix` for smoke tests, and `~/.local/bin` for normal installation.
- Produces: `installPreview(options):InstallResult`, `uninstallPreview(options):UninstallResult`, and an ownership marker `.streamhub-preview-install.json` in every managed payload.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
test('install is repeatable and never copies package-local data',async()=>{
  const first=await installPreview(fixture());
  const second=await installPreview(fixture());
  expect(second).toEqual(first);
  expect(realpathSync(commandPath)).toBe(join(first.installRoot,'bin/streamhub'));
  expect(existsSync(join(first.installRoot,'.streamhub'))).toBe(false);
  expect(existsSync(dataRoot)).toBe(false);
});

test('uninstall removes only a marked version and preserves data',async()=>{
  await installPreview(fixture());mkdirSync(dataRoot,{recursive:true});writeFileSync(join(dataRoot,'studio.json'),'keep');
  await uninstallPreview(fixture());
  expect(existsSync(installRoot)).toBe(false);expect(existsSync(commandPath)).toBe(false);
  expect(readFileSync(join(dataRoot,'studio.json'),'utf8')).toBe('keep');
});
```

Also test refusal of symlinked destinations, unmarked existing payloads, foreign command shims, invalid manifests, broad/root prefixes, and uninstall of a missing version.

- [ ] **Step 2: Run installer tests and verify RED**

Run: `bun test packages/release/install.test.ts`

Expected: FAIL because the installer module is missing.

- [ ] **Step 3: Implement exact-target install and uninstall**

```ts
const MARKER='.streamhub-preview-install.json';
export async function installPreview(options:InstallOptions){
  const manifest=validateReleaseManifest(readJson(join(options.packageRoot,'manifest.json')));
  const destination=join(options.applicationSupport,'Streamhub','app',manifest.version);
  assertSafeDestination(destination,options.applicationSupport);
  // Stage sibling directory, copy approved package entries, write marker,
  // rename atomically, then create only the exact ~/.local/bin symlink.
}
```

Never recursively remove a path until its resolved parent, version basename, marker ownership, and expected manifest identity all match. Back up an older same-version marked payload before replacement and remove that backup only after the new install validates.

- [ ] **Step 4: Add thin fallback scripts and run GREEN**

Both shell scripts locate their package root and `exec bun app/install.js install|uninstall` with literal arguments. They contain no filesystem mutation beyond invoking the tested entry point.

Run: `bun test packages/release/install.test.ts && bun run typecheck`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/release/install.ts packages/release/install.test.ts scripts/preview-install.ts packaging/install.sh packaging/uninstall.sh
git commit -m "feat(release): install previews without touching user data"
```

---

### Task 5: Atomic package assembler and extracted smoke test

**Files:**
- Replace: `scripts/build.ts`
- Create: `scripts/package.ts`
- Create: `scripts/package.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Tasks 1–4 sources/templates, root lockfile, production dependencies, editor web sources, native helper source, and built plugin.
- Produces: `assemblePreview(options):Promise<PackageResult>`, `dist/streamhub-<version>-macos-arm64/`, its `.tar.gz`, `manifest.json`, and `SHA256SUMS`.

- [ ] **Step 1: Write failing assembly and exclusion tests**

```ts
test('assembler creates the complete allowlisted payload',async()=>{
  const result=await assemblePreview(fixture());
  expect(relativeFiles(result.root)).toEqual(expect.arrayContaining([
    'README.md','DEVELOPMENT.md','manifest.json','SHA256SUMS','install.sh','uninstall.sh','bin/streamhub',
    'app/cli.js','app/runtime.js','app/studio.js','app/native/session-monitor.swift',
    'share/studio/index.html','share/studio/app.js','share/streamdeck-plugin/com.streamhub.studio.sdPlugin/manifest.json'
  ]));
  expect(relativeFiles(result.root).some(path=>/(^|\/)(\.streamhub|\.git|logs|.*\.test\.|.*\.map$)/.test(path))).toBe(false);
});

test('every payload file has one sorted checksum and a valid manifest',async()=>{
  const result=await assemblePreview(fixture());
  expect(verifyChecksums(result.root)).toEqual({valid:true,missing:[],extra:[]});
  expect(validateReleaseManifest(readJson(join(result.root,'manifest.json'))).target).toBe('macos-arm64');
});
```

Use injected build/install/archive runners in unit tests. The real `bun run package` is the integration gate.

- [ ] **Step 2: Run package tests and verify RED**

Run: `bun test scripts/package.test.ts`

Expected: FAIL because `assemblePreview` does not exist.

- [ ] **Step 3: Implement allowlisted staging**

```ts
const REQUIRED_TOP_LEVEL=['README.md','DEVELOPMENT.md','install.sh','uninstall.sh','bin','app','share'] as const;
export async function assemblePreview(options:PackageOptions){
  assertPlatform(options.platform,options.arch);
  const staging=await mkdtemp(join(options.tempRoot,'streamhub-package-'));
  // Build into staging only; copy exact allowlisted inputs; never copy repo roots.
  // Install production dependencies in staging/app from package.json + bun.lock.
  // Remove plugin logs, validate, checksum, then atomically publish dist outputs.
}
```

Use `Bun.build` for `main.ts`, `preview-cli.ts`, and `packaged-studio.ts` with `target:'bun'` and `packages:'external'`. Build the browser from `packages/editor/web/app.ts` and copy the five declared static files. Run `bun install --production --frozen-lockfile --cwd <staging>/app`. Package the plugin only after `streamdeck:plugin:check` succeeds.

- [ ] **Step 4: Implement archive and outside-repository smoke checks**

After checksum verification, invoke `/usr/bin/tar` with sorted staging input to create the `.tar.gz`. Extract to a new temporary path containing a space and run:

```sh
./bin/streamhub version
./bin/streamhub status
./install.sh --prefix /private/tmp/streamhub-preview-smoke
/private/tmp/streamhub-preview-smoke/bin/streamhub version
/private/tmp/streamhub-preview-smoke/bin/streamhub uninstall
```

The explicit smoke prefix must be rejected if it is `/`, a home directory, a symlink, or an unmarked nonempty directory.

- [ ] **Step 5: Add scripts and run GREEN**

Add `"package": "bun scripts/package.ts"` and update `build` to produce Runtime plus Studio browser assets without writing user state. Ignore only completed archive/staging outputs under `dist/`.

Run: `bun test scripts/package.test.ts && bun run typecheck`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/build.ts scripts/package.ts scripts/package.test.ts package.json .gitignore
git commit -m "build(release): assemble the macOS preview archive"
```

---

### Task 6: User README and developer documentation split

**Files:**
- Replace: `README.md`
- Create: `DEVELOPMENT.md`
- Modify: internal links in `docs/` only when a moved README anchor breaks them.

**Interfaces:**
- Consumes: the exact commands and paths implemented by Tasks 1–5.
- Produces: a user-only README and complete contributor/developer reference.

- [ ] **Step 1: Inventory and classify the existing README sections**

Move source checkout, `bun run`, protocol JSON, architecture, test, simulator, diagnostics, and physical validation material into DEVELOPMENT.md. Preserve the technical statements and links; do not silently delete known limitations.

- [ ] **Step 2: Write the user README**

README must open with the product outcome, then show this first-run path exactly:

```sh
tar -xzf streamhub-0.1.0-preview.1-macos-arm64.tar.gz
cd streamhub-0.1.0-preview.1-macos-arm64
./install.sh
streamhub setup
streamhub start
# another terminal
streamhub studio
```

Explain HID versus plugin ownership, Runtime restart after mode changes, Studio page/background/standby/button/icon/label/animation editing, Ctrl-C shutdown, `streamhub status`, update by installing a newer archive, and preserving uninstall. Include short fixes for port 31415/31416 conflicts, HID ownership, plugin connection, Accessibility permission, missing Command Line Tools, and `~/.local/bin` not on PATH.

- [ ] **Step 3: Write DEVELOPMENT.md**

Start with source prerequisites and `bun install --frozen-lockfile`, then retain build/test/package, source/collector contracts, architecture, simulator, HID/plugin diagnostics, validation evidence, and design links. Make it explicit that `.streamhub` is repository-local development state and never release input.

- [ ] **Step 4: Verify documentation against the built CLI**

Run:

```sh
rg -n "bun run|packages/|node_modules|simulator:|hid:check|source:register" README.md
rg -n "bun run check|bun run package|packages/core|source:register|hid:check" DEVELOPMENT.md
```

Expected: the first command has no matches; the second finds every named developer topic. Manually compare every README command with `streamhub --help` from the staged package.

- [ ] **Step 5: Commit**

```bash
git add README.md DEVELOPMENT.md docs
git commit -m "docs: separate preview usage from development"
```

---

### Task 7: Produce and accept the preview artifact

**Files:**
- Generated, not committed: `dist/streamhub-0.1.0-preview.1-macos-arm64/`
- Generated, not committed: `dist/streamhub-0.1.0-preview.1-macos-arm64.tar.gz`
- Modify only if verification finds a defect: files owned by Tasks 1–6, with a separate fix commit.

**Interfaces:**
- Consumes: the complete package pipeline and documentation.
- Produces: the checked preview archive plus recorded hashes in the final handoff.

- [ ] **Step 1: Run all automated gates**

Run: `bun run check && bun run streamdeck:plugin:check && git diff --check`

Expected: 0 failing tests, plugin typecheck/build pass, and no whitespace errors.

- [ ] **Step 2: Build the real archive**

Run: `bun run package`

Expected: prints only the artifact paths, version, target, and public checksum; never prints environment, config, token, device path, or user data.

- [ ] **Step 3: Inspect exclusions and checksums**

Run:

```sh
tar -tzf dist/streamhub-0.1.0-preview.1-macos-arm64.tar.gz
shasum -a 256 dist/streamhub-0.1.0-preview.1-macos-arm64.tar.gz
```

Verify the listing contains no `.streamhub`, `.git`, `logs`, tests, source maps, config, token, or build-machine absolute paths. Run the package's checksum verifier after extraction.

- [ ] **Step 4: Perform an isolated install smoke test**

Extract under a temporary path containing spaces, install with an explicit temporary prefix, run `streamhub version`, `streamhub status`, start Runtime in `off` mode long enough to return a healthy `/v1/state`, start Studio with `--no-open` long enough to fetch `/`, then uninstall. Confirm the temporary data directory survives uninstall.

- [ ] **Step 5: Perform one real user-path acceptance**

With explicit user confirmation because this changes the real user install, run the archive's normal `./install.sh`, `streamhub setup hid`, `streamhub start`, and `streamhub studio`. Confirm the configured standby screen survives one lock/unlock and a Studio edit applies to the device. Do not change to plugin mode unless the user asks to stop the HID Runtime and open Stream Deck App.

- [ ] **Step 6: Commit any release-only fixes and report the artifact**

If Step 1–5 required no fixes, do not create an empty commit. Report the archive path, archive SHA-256, manifest version/commit, install command, automated test totals, smoke-test result, and the explicit unsigned/unnotarized preview limitation.
