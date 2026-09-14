# Runtime LaunchAgent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit user LaunchAgent workflow that starts only Runtime at login while preserving foreground `streamhub start` and foreground Studio.

**Architecture:** A pure launch-agent definition module owns paths, XML, ownership validation, and bounded status parsing. A daemon controller owns exact `/bin/launchctl` operations and managed logs behind injected effects; the existing release CLI and installer delegate to it. Fresh installation and display setup stay side-effect free, while enabled service state survives safe package replacement and is removed before uninstall.

**Tech Stack:** Bun 1.4.0, TypeScript 5.9, macOS launchd/launchctl, XML property lists, Bun test, POSIX shell.

**Spec:** `docs/superpowers/specs/2026-09-14-runtime-launchagent-design.md`

## Global Constraints

- Target only Apple Silicon macOS 13 or newer for `0.1.0-preview.1`.
- Manage only the current user label `com.streamhub.runtime` in `gui/<uid>`; never use `sudo` or a system daemon.
- A fresh `./install.sh` and every `streamhub setup` invocation must not enable or start a service.
- `streamhub start` remains foreground and must refuse before Runtime side effects when the owned job is loaded.
- Only Runtime starts at login. Studio remains `streamhub studio [--no-open]`, foreground, and Ctrl-C controlled.
- Use absolute paths for Bun, installed `app/runtime.ts`, working directory, config, plist, and log.
- Reject symlinked, foreign, malformed, or unexpectedly located service definitions before overwrite or removal.
- Use literal argv with `/bin/launchctl` and `/usr/bin/plutil`; never evaluate a shell command.
- Preserve config, Studio documents/assets, SQLite state, plugin credentials, and Runtime logs on disable and uninstall.
- Status and errors must not expose plist bodies, environment, tokens, raw launchctl output, device paths, or arbitrary files.
- Use TDD and create one reviewed commit per task.

---

### Task 1: Pure LaunchAgent definition and ownership contract

**Files:**
- Create: `packages/release/launch-agent.ts`
- Create: `packages/release/launch-agent.test.ts`

**Interfaces:**
- Consumes: an installed marked package root, its derived application root, current user home/uid, and the exact `process.execPath` Bun path.
- Produces: `launchAgentPaths(input):LaunchAgentPaths`, `renderLaunchAgent(input):string`, `validateOwnedLaunchAgent(xml,expected):void`, and `parseLaunchctlPrint(output):LaunchctlState`.

- [ ] **Step 1: Write failing path and plist tests**

```ts
import {expect,test} from 'bun:test';
import {launchAgentPaths,parseLaunchctlPrint,renderLaunchAgent,validateOwnedLaunchAgent} from './launch-agent';

const input={
  home:'/Users/example',uid:501,bunPath:'/opt/homebrew/bin/bun',
  packageRoot:'/Users/example/Library/Application Support/Streamhub/app/0.1.0-preview.1',
};

test('LaunchAgent paths remain inside the user and installed Streamhub roots',()=>{
  expect(launchAgentPaths(input)).toEqual({
    label:'com.streamhub.runtime',domain:'gui/501',service:'gui/501/com.streamhub.runtime',
    plistPath:'/Users/example/Library/LaunchAgents/com.streamhub.runtime.plist',
    configPath:'/Users/example/Library/Application Support/Streamhub/data/config.json',
    logPath:'/Users/example/Library/Application Support/Streamhub/data/logs/runtime.log',
    previousLogPath:'/Users/example/Library/Application Support/Streamhub/data/logs/runtime.log.1',
    runtimePath:'/Users/example/Library/Application Support/Streamhub/app/0.1.0-preview.1/app/runtime.ts',
  });
});

test('rendered plist is escaped, owned, absolute and round-trips validation',()=>{
  const xml=renderLaunchAgent({...input,bunPath:'/Applications/Bun & Tools/bin/bun'});
  expect(xml).toContain('<!-- Managed by Streamhub Preview -->');
  expect(xml).toContain('/Applications/Bun &amp; Tools/bin/bun');
  expect(()=>validateOwnedLaunchAgent(xml,input)).toThrow('Bun path');
  expect(()=>validateOwnedLaunchAgent(renderLaunchAgent(input),input)).not.toThrow();
});

test('launchctl output projects only bounded process state',()=>{
  expect(parseLaunchctlPrint('state = running\npid = 123\nlast exit code = 7\ntoken = secret')).toEqual({loaded:true,running:true,pid:123,lastExitStatus:7});
  expect(parseLaunchctlPrint('state = exited\nlast exit code = 0')).toEqual({loaded:true,running:false,lastExitStatus:0});
});
```

- [ ] **Step 2: Run Task 1 tests and verify RED**

Run: `bun test packages/release/launch-agent.test.ts`

Expected: FAIL because `./launch-agent` does not exist.

- [ ] **Step 3: Implement strict pure contracts**

```ts
export const runtimeLabel='com.streamhub.runtime' as const;
export type LaunchAgentInput={home:string;uid:number;bunPath:string;packageRoot:string};
export type LaunchAgentPaths={label:typeof runtimeLabel;domain:string;service:string;plistPath:string;configPath:string;logPath:string;previousLogPath:string;runtimePath:string};
export type LaunchctlState={loaded:boolean;running:boolean;pid?:number;lastExitStatus?:number};

export function launchAgentPaths(input:LaunchAgentInput):LaunchAgentPaths;
export function renderLaunchAgent(input:LaunchAgentInput):string;
export function validateOwnedLaunchAgent(xml:string,expected:LaunchAgentInput):void;
export function parseLaunchctlPrint(output:string):LaunchctlState;
```

Require absolute inputs with no NUL, a positive integral uid, package root shape `<applicationRoot>/app/<version>`, and basename `Streamhub` for the application root. XML-escape all text values. Render `RunAtLoad=true`, `KeepAlive.SuccessfulExit=false`, one shared standard output/error log, working directory, `STREAMHUB_CONFIG`, and a 10-second throttle interval. Validation must require the ownership comment, exact label and exact escaped path values; it must reject extra `ProgramArguments`.

`parseLaunchctlPrint` accepts only `running`, positive integral pid, and signed 32-bit last exit status. It ignores all other output and never returns raw text.

- [ ] **Step 4: Run pure contract tests and typecheck**

Run: `bun test packages/release/launch-agent.test.ts && bun run typecheck`

Expected: all Task 1 tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/release/launch-agent.ts packages/release/launch-agent.test.ts
git commit -m "feat(runtime): define owned LaunchAgent contract"
```

---

### Task 2: Runtime daemon controller and managed logs

**Files:**
- Create: `packages/release/daemon.ts`
- Create: `packages/release/daemon.test.ts`

**Interfaces:**
- Consumes: Task 1 definition functions, explicit installed package/home/Bun/uid inputs, an injected literal-argv runner, and temporary real filesystem fixtures in tests.
- Produces: `createRuntimeDaemon(options):RuntimeDaemon`, `DaemonStatus`, `readRuntimeLog(paths,maxBytes)`, and `prepareRuntimeLog(paths)`.

- [ ] **Step 1: Write failing lifecycle tests with a fake launchctl runner**

```ts
type Recorded={commands:string[][];loaded:boolean;running:boolean;plist?:string};

test('enable validates, bootstraps and repeats without replacing a live identical job',async()=>{
  const h=daemonFixture();
  expect(await h.daemon.enable()).toEqual({enabled:true,loaded:true,running:true});
  expect(h.recorded.commands).toEqual([
    ['/usr/bin/plutil','-lint',h.paths.plistPath],
    ['/bin/launchctl','bootstrap',h.paths.domain,h.paths.plistPath],
    ['/bin/launchctl','print',h.paths.service],
  ]);
  h.recorded.commands.length=0;
  await h.daemon.enable();
  expect(h.recorded.commands).toEqual([['/bin/launchctl','print',h.paths.service]]);
});

test('disable and restart operate only on an owned loaded definition',async()=>{
  const h=daemonFixture();await h.daemon.enable();h.recorded.commands.length=0;
  await h.daemon.restart();
  expect(h.recorded.commands).toEqual([
    ['/bin/launchctl','print',h.paths.service],
    ['/bin/launchctl','kickstart','-k',h.paths.service],
    ['/bin/launchctl','print',h.paths.service],
  ]);
  h.recorded.commands.length=0;await h.daemon.disable();
  expect(h.recorded.commands[0]).toEqual(['/bin/launchctl','print',h.paths.service]);
  expect(h.recorded.commands[1]).toEqual(['/bin/launchctl','bootout',h.paths.service]);
  expect(h.exists(h.paths.plistPath)).toBe(false);
});

test('foreign and linked definitions cause no launchctl mutation',async()=>{
  for(const kind of ['foreign','symlink'] as const){const h=daemonFixture({existing:kind});await expect(h.daemon.enable()).rejects.toThrow(kind==='foreign'?'owned':'symbolic');expect(h.recorded.commands).toEqual([]);}
});
```

Also test bootstrap rollback to prior bytes, failed bootout preserving plist, restart while disabled, enabled-but-not-running status, missing job normalization, exact mode `0600`, log rollover at `5 * 1024 * 1024 + 1`, no rollover at the boundary, bounded last 200 lines, and symlinked log rejection.

- [ ] **Step 2: Run daemon tests and verify RED**

Run: `bun test packages/release/daemon.test.ts`

Expected: FAIL because `createRuntimeDaemon` and `readRuntimeLog` do not exist.

- [ ] **Step 3: Implement the controller with injected effects**

```ts
export type CommandResult={code:number;stdout:string;stderr:string};
export type CommandRunner=(argv:readonly string[])=>Promise<CommandResult>;
export type DaemonStatus={enabled:boolean;loaded:boolean;running:boolean;pid?:number;lastExitStatus?:number};
export type DaemonOptions=LaunchAgentInput&{runner?:CommandRunner};
export type RuntimeDaemon={
  enable():Promise<DaemonStatus>;
  disable():Promise<DaemonStatus>;
  restart():Promise<DaemonStatus>;
  status():Promise<DaemonStatus>;
  paths:LaunchAgentPaths;
};
export function createRuntimeDaemon(options:DaemonOptions):RuntimeDaemon;
export function readRuntimeLog(paths:LaunchAgentPaths,maxBytes?:number):string;
export function prepareRuntimeLog(paths:LaunchAgentPaths):string;
```

The default runner uses `Bun.spawn` with `stdin:'ignore'`, piped bounded output, and no shell. Treat exit code 0 from `launchctl print` as loaded and its documented “service not found” result as unloaded; collapse every other failure into a stable public message without including stdout/stderr.

Before any write, read and validate an existing regular plist. Write a same-directory temporary with mode `0600`, run `/usr/bin/plutil -lint <temporary>`, then rename it. If the definition changes while loaded, boot out before publication and bootstrap the new definition. On failure, restore the old bytes and loaded state. Remove a plist only after a successful bootout or after proving the job was not loaded.

Implement log rollover only during enable/restart: reject links, rename `runtime.log` to `runtime.log.1` above 5 MiB, remove only the exact prior managed log, and never traverse a user-supplied path. `readRuntimeLog` returns at most 64 KiB and the latest 200 lines from `paths.logPath`. `prepareRuntimeLog` validates or creates that exact regular file with mode `0600` for follow mode.

- [ ] **Step 4: Run daemon tests, release regressions, and typecheck**

Run: `bun test packages/release/daemon.test.ts packages/release/launch-agent.test.ts packages/release/install.test.ts && bun run typecheck`

Expected: all selected tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/release/daemon.ts packages/release/daemon.test.ts
git commit -m "feat(runtime): manage the user LaunchAgent"
```

---

### Task 3: Explicit daemon CLI without changing foreground commands

**Files:**
- Modify: `packages/release/cli.ts`
- Modify: `packages/release/cli.test.ts`
- Modify: `scripts/preview-cli.ts`

**Interfaces:**
- Consumes: Task 2 `RuntimeDaemon`, existing sanitized display status, installed package root, current home/uid, and `process.execPath`.
- Produces: new `PreviewCommand` daemon variants and user commands `daemon enable|disable|restart|status|logs [--follow]`.

- [ ] **Step 1: Extend parser tests and foreground exclusion tests**

```ts
test('CLI accepts the exact daemon grammar and keeps Studio unchanged',()=>{
  expect(parsePreviewCommand(['daemon','enable'])).toEqual({type:'daemon',operation:'enable'});
  expect(parsePreviewCommand(['daemon','disable'])).toEqual({type:'daemon',operation:'disable'});
  expect(parsePreviewCommand(['daemon','restart'])).toEqual({type:'daemon',operation:'restart'});
  expect(parsePreviewCommand(['daemon','status'])).toEqual({type:'daemon',operation:'status'});
  expect(parsePreviewCommand(['daemon','logs'])).toEqual({type:'daemon',operation:'logs',follow:false});
  expect(parsePreviewCommand(['daemon','logs','--follow'])).toEqual({type:'daemon',operation:'logs',follow:true});
  expect(parsePreviewCommand(['studio'])).toEqual({type:'studio',open:true});
  for(const argv of [['daemon'],['daemon','start'],['daemon','logs','--bad'],['studio','stop']])expect(()=>parsePreviewCommand(argv)).toThrow('Usage');
});

test('foreground start refuses before spawning when the service is loaded',async()=>{
  const h=dependencies({daemonStatus:{enabled:true,loaded:true,running:true,pid:123}});
  expect(await main(['start'],h.deps)).toBe(1);
  expect(h.calls).toEqual(['daemon:status','write:Runtime daemon is enabled. Run streamhub daemon disable first.']);
});
```

Extend the routing table test so each daemon mutation is called once, JSON status contains only bounded fields, logs use the exact managed log, setup performs no daemon mutation, and Studio still calls only its foreground child entry. When setup finds an enabled daemon, assert its guidance includes `streamhub daemon restart` without invoking restart.

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `bun test packages/release/cli.test.ts`

Expected: FAIL because the daemon grammar and dependencies are absent.

- [ ] **Step 3: Add daemon commands and construct the installed controller**

```ts
export type DaemonCommand={type:'daemon';operation:'enable'|'disable'|'restart'|'status'}|{type:'daemon';operation:'logs';follow:boolean};
export type PreviewCommand=ExistingPreviewCommand|DaemonCommand;
```

Add `daemon:RuntimeDaemon`, `readDaemonLog():string`, and `followDaemonLog():Promise<number>` to `PreviewDependencies`. `main(['start'])` queries daemon status first and spawns the existing `runtime.ts` child only when unloaded. Enable/disable/restart print a short stable result. Daemon status prints only `DaemonStatus` plus the existing sanitized Runtime display result. Logs print the bounded tail; `--follow` runs `/usr/bin/tail -n 200 -f <exact-managed-log>` through literal argv after `prepareRuntimeLog` validation. Setup may query daemon status only to append restart guidance and never changes its loaded state.

In `scripts/preview-cli.ts`, refuse daemon mutations/log access unless `.streamhub-preview-install.json` exists in `STREAMHUB_PACKAGE_ROOT`. Construct `createRuntimeDaemon` from `homedir()`, `process.getuid()`, `process.execPath`, and the installed root. For a non-installed extracted tree, expose only an unloaded status so foreground start remains possible and every daemon operation says installation is required. Do not change the Studio entry, browser behavior, or signal handlers.

- [ ] **Step 4: Run CLI, daemon, packaged Studio, and type tests**

Run: `bun test packages/release/cli.test.ts packages/release/daemon.test.ts scripts/packaged-studio.test.ts && bun run typecheck`

Expected: all tests pass and Studio still starts/stops in the foreground.

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/release/cli.ts packages/release/cli.test.ts scripts/preview-cli.ts
git commit -m "feat(cli): expose explicit Runtime daemon commands"
```

---

### Task 4: Service-aware install, update rollback, and uninstall

**Files:**
- Modify: `packages/release/install.ts`
- Modify: `packages/release/install.test.ts`
- Modify: `scripts/preview-install.ts`

**Interfaces:**
- Consumes: Task 2 `RuntimeDaemon`, existing marked exact-target package transaction, and normal/custom-prefix location resolution.
- Produces: `InstallServiceHooks<State>` accepted by `installPreview`, and ordered service removal accepted by `uninstallPreview`.

- [ ] **Step 1: Write failing update and uninstall ordering tests**

```ts
test('an enabled service is stopped before replacement and restored on the new payload',async()=>{
  const h=fixture({installedCommit:'a'.repeat(40),packageCommit:'b'.repeat(40)}),events:string[]=[];
  await installPreview({...h.options,service:{
    prepare:async()=>{events.push('disable-old');return{wasEnabled:true};},
    activate:async(_state,result)=>{expect(existsSync(result.installRoot)).toBe(true);events.push('enable-new');},
    rollback:async()=>events.push('restore-old'),
  }});
  expect(events).toEqual(['disable-old','enable-new']);
});

test('failed service activation restores the old payload and service state',async()=>{
  const h=fixture({installedCommit:'a'.repeat(40),packageCommit:'b'.repeat(40)}),events:string[]=[];
  await expect(installPreview({...h.options,service:{prepare:async()=>({wasEnabled:true}),activate:async()=>{throw new Error('bootstrap failed');},rollback:async()=>{events.push('restore-old');}}})).rejects.toThrow('bootstrap');
  expect(readInstalledCommit(h.installRoot)).toBe('a'.repeat(40));
  expect(events).toEqual(['restore-old']);
});

test('uninstall stops the owned service before removing any program path',async()=>{
  const h=fixture(),events:string[]=[];const installed=await installPreview(h.options);
  await uninstallPreview({...h.options,packageRoot:installed.installRoot,beforeRemove:async()=>{expect(existsSync(installed.installRoot)).toBe(true);events.push('disable');}});
  expect(events).toEqual(['disable']);expect(existsSync(installed.installRoot)).toBe(false);
});
```

Also test fresh install with no plist performs no daemon operation, foreign plist aborts before payload mutation, disable failure preserves the existing package, repeated same-commit install does not restart the daemon, and custom-prefix self-uninstall targets its own plist/data roots.

- [ ] **Step 2: Run installer tests and verify RED**

Run: `bun test packages/release/install.test.ts`

Expected: FAIL because service transaction hooks are not accepted.

- [ ] **Step 3: Extend the exact-target transaction**

```ts
export type InstallResult={installRoot:string;commandPath:string;dataRoot:string};
export type InstallServiceHooks<State>={
  prepare(context:{currentRoot?:string;targetRoot:string}):Promise<State>;
  activate(state:State,result:InstallResult):Promise<void>;
  rollback(state:State,context:{restoredRoot?:string}):Promise<void>;
};
export type InstallOptions<State=never>={
  packageRoot:string;applicationRoot:string;binDirectory:string;
  service?:InstallServiceHooks<State>;
};
export type UninstallOptions={packageRoot:string;applicationRoot:string;binDirectory:string;beforeRemove?:()=>Promise<void>};
```

Call `prepare` only after manifest, target, command, marker, and existing ownership validation, but before renaming any payload. Keep the old package backup and command target until `activate` succeeds. If publication or activation fails, remove only the exact newly marked target, restore the backup and command link, then call `rollback`; report the original failure while preserving rollback failure as bounded context. Call `beforeRemove` after all uninstall ownership checks and before unlinking the command or deleting the payload.

In `scripts/preview-install.ts`, inspect only the exact expected plist through Task 2. Fresh install supplies no active lifecycle. Owned enabled updates disable the old controller, activate the new controller after publication, and restore the old controller on rollback. Uninstall calls `disable` before removal. A foreign plist causes refusal without filesystem mutation.

- [ ] **Step 4: Run installer, daemon, manifest, and type tests**

Run: `bun test packages/release/install.test.ts packages/release/daemon.test.ts packages/release/manifest.test.ts && bun run typecheck`

Expected: all tests pass, including prior user-data preservation cases.

- [ ] **Step 5: Commit Task 4**

```bash
git add packages/release/install.ts packages/release/install.test.ts scripts/preview-install.ts
git commit -m "feat(release): preserve Runtime service across updates"
```

---

### Task 5: Package and document the daemon workflow

**Files:**
- Modify: `scripts/package.test.ts`
- Create: `scripts/release-docs.test.ts`
- Modify: `README.md`
- Modify: `DEVELOPMENT.md`

**Interfaces:**
- Consumes: Tasks 1–4 compiled CLI/installer and the existing unbundled `app/runtime.ts` package layout.
- Produces: a preview archive whose installed CLI manages the LaunchAgent and user documentation matching the exact command grammar.

- [ ] **Step 1: Add package smoke assertions for daemon help and exclusions**

Extend `scripts/package.test.ts` so the staged package contains updated `app/cli.js` and `app/install.js` and contains no source plist or machine path. Add the following documentation contract test:

```ts
import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

test('user docs describe explicit Runtime-only login service commands',()=>{
  const readme=readFileSync('README.md','utf8'),development=readFileSync('DEVELOPMENT.md','utf8');
  for(const command of ['streamhub daemon enable','streamhub daemon disable','streamhub daemon restart','streamhub daemon status','streamhub daemon logs'])expect(readme).toContain(command);
  expect(readme).toContain('Studio는 로그인 시 자동 실행되지 않습니다');expect(readme).toContain('Ctrl-C');
  expect(readme).not.toContain('streamhub daemon studio');
  expect(development).toContain('com.streamhub.runtime');
});
```

Assert package-relative files still exclude `.streamhub`, `.git`, tests, source maps, logs, config, token files, and build-machine absolute paths.

- [ ] **Step 2: Run package tests and verify RED**

Run: `bun test scripts/package.test.ts scripts/release-docs.test.ts`

Expected: the documentation contract FAILS because README and DEVELOPMENT.md do not yet describe daemon commands.

- [ ] **Step 3: Update user and developer documentation**

Change the README first-run flow to:

```sh
./install.sh
streamhub setup hid
streamhub daemon enable
streamhub daemon status
streamhub studio
```

Document that `daemon enable` starts only Runtime now and at login, `daemon disable` stops and disables it, `streamhub start` is foreground diagnosis, and Studio remains foreground until Ctrl-C. For HID, require disabling Stream Deck app login launch. Add update, log, crash-loop, foreign plist, and disable-before-foreground troubleshooting.

In DEVELOPMENT.md, document the LaunchAgent trust boundary, injected fake-runner tests, exact plist/data locations, service-aware package update order, and the real-user acceptance commands. Remove the old packaging statement that launchd is out of scope and update links to the new spec and plan.

- [ ] **Step 4: Build and verify documentation against packaged help**

Run:

```sh
bun run build
bun test scripts/package.test.ts scripts/release-docs.test.ts
bun dist/build/app/cli.js
rg -n "daemon enable|daemon disable|daemon restart|daemon status|daemon logs" README.md DEVELOPMENT.md
rg -n "Studio.*login|Studio.*LaunchAgent|studio.*foreground" README.md DEVELOPMENT.md
git diff --check
```

Expected: the no-argument CLI exits 2 with the documented usage; both docs describe Runtime-only login start; no documentation claims Studio starts automatically.

- [ ] **Step 5: Commit Task 5**

```bash
git add scripts/package.test.ts scripts/release-docs.test.ts README.md DEVELOPMENT.md docs
git commit -m "docs(release): document Runtime login service"
```

---

### Task 6: Full archive verification and real user LaunchAgent acceptance

**Files:**
- Generated, not committed: `dist/streamhub-0.1.0-preview.1-macos-arm64/`
- Generated, not committed: `dist/streamhub-0.1.0-preview.1-macos-arm64.tar.gz`
- Modify only for defects found by this task: files owned by Tasks 1–5, with one focused fix commit per defect

**Interfaces:**
- Consumes: the complete package pipeline, current user launchd domain, installed Streamhub preview, and explicit user confirmation before changing the real user service.
- Produces: a checksummed archive and evidence that Runtime alone survives login-style service lifecycle while Studio remains manual.

- [ ] **Step 1: Run all automated gates**

Run: `bun run check && bun run streamdeck:plugin:check && git diff --check`

Expected: all repository and plugin tests pass with zero failures.

- [ ] **Step 2: Build and inspect the real archive**

Run: `bun run package`

Then run:

```sh
tar -tzf dist/streamhub-0.1.0-preview.1-macos-arm64.tar.gz
shasum -a 256 dist/streamhub-0.1.0-preview.1-macos-arm64.tar.gz
```

Expected: no plist is preinstalled in the archive, no private/development artifacts appear, manifest/checksums validate, and the artifact remains unsigned/unnotarized.

- [ ] **Step 3: Run source-independent foreground and package smoke checks**

Extract under a temporary path containing a space and install with a temporary prefix. Verify `version`, foreground `start` in `off` mode on a non-user port, Studio HTML on port 31416, `status`, and preserving uninstall. Do not invoke launchctl from the prefix smoke because the label is global to the current GUI domain.

- [ ] **Step 4: Pause for real user-service authorization**

Ask the user to stop any foreground Runtime and confirm that changing `~/Library/LaunchAgents/com.streamhub.runtime.plist` is acceptable. For HID acceptance, also ask them to quit Stream Deck App and disable its login launch. Do not bootstrap the real service before this confirmation.

- [ ] **Step 5: Install and exercise the real LaunchAgent**

After confirmation, install the archive normally and run:

```sh
streamhub setup hid
streamhub daemon enable
streamhub daemon status
streamhub daemon restart
streamhub daemon logs
```

Verify port 31415 is served by the launchd child, the device reaches ready in HID mode, the invoking terminal is free, no Studio process/browser starts, and foreground `streamhub start` refuses without touching the database/device. Launch Studio manually, verify it edits the daemon-owned Runtime, then stop Studio with Ctrl-C without affecting Runtime.

- [ ] **Step 6: Verify login-style restart, disable, and enabled update**

Use `launchctl bootout gui/<uid>/com.streamhub.runtime` followed by a fresh bootstrap of the installed owned plist to model a login load without logging the user out. Confirm Runtime becomes ready and Studio remains absent. Reinstall the same archive while enabled and verify the job returns with the same owned definition and user data. Run `streamhub daemon disable`; confirm Runtime stops and the plist is removed. Re-enable for the user’s desired final state.

- [ ] **Step 7: Verify preserving uninstall and restore desired state**

Create a harmless sentinel under the Streamhub data directory, enable the daemon, then run `streamhub uninstall`. Confirm job and owned plist disappear before the app path, command link is removed, and the sentinel remains. Reinstall and re-enable only if the user wants Streamhub left active after acceptance.

- [ ] **Step 8: Commit defects separately and report evidence**

For each defect, write a failing automated regression, implement the minimal fix, run the focused suite and full gates, then make a focused commit. If no defects are found, do not create an empty commit. Report test totals, service lifecycle observations, artifact path/SHA-256, manifest commit, final installed/enabled state, and unsigned/unnotarized status.
