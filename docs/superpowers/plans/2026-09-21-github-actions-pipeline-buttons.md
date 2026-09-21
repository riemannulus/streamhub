# GitHub Actions Pipeline Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four Stream Deck buttons that safely dispatch the Crepe backend RC and production promotion workflows, track their chained deployment workflows including the Stg approval gate, and open the exact run or failed job.

**Architecture:** A deep `GitHubActionsPipeline` module owns authenticated `gh` CLI access, correlation, polling, persistence, and normalized button snapshots behind one small interface. Studio stores only a trusted pipeline ID and `trigger | deployment` role; Presentation renders snapshots and delegates press/hold activation without learning GitHub response shapes. Runtime injects a production CLI adapter while tests and the simulator inject deterministic adapters.

**Tech Stack:** Bun 1.4.0, TypeScript 5.9, Bun SQLite, GitHub CLI, existing Studio v3 document model, Presentation compositor, HID/Stream Deck plugin backends.

**Spec:** `docs/superpowers/specs/2026-09-21-github-actions-pipeline-buttons-design.md`

## Global Constraints

- Do not modify the `cookieplace/crepe` workflow files.
- Do not store or print a GitHub token; reuse the authenticated `gh` CLI and never invoke `gh auth token`.
- Invoke external processes with literal argv, a 60-second maximum timeout, a 1 MiB combined output cap, and AbortSignal cancellation.
- Only trusted Runtime configuration can name repositories, workflows, refs, inputs, anchor steps, or tag patterns.
- Only allow URLs under `https://github.com/cookieplace/crepe/` for this configured integration.
- Read `pending_deployments`; never approve or reject an Environment from Streamhub.
- RC cut dispatches on press. Prod promotion dispatches only on a 700ms hold; press opens its current or latest run.
- Pipeline buttons use remote snapshots as the display truth and must not reuse the local action completion state.
- Automatic tests must never dispatch a real GitHub workflow.
- Preserve unrelated user changes and the existing Studio document when registering the local Crepe page.

---

## File Structure

- `packages/github-actions/types.ts` — trusted definitions, normalized run/release/job values, public pipeline snapshots and interfaces.
- `packages/github-actions/crepe.ts` — the two trusted Crepe pipeline definitions; no credentials or user data.
- `packages/github-actions/cli.ts` — production `gh` adapter and strict JSON/URL normalization.
- `packages/github-actions/state.ts` — pure status normalization, failed-job choice and downstream correlation.
- `packages/github-actions/store.ts` — namespaced persistence over the existing SQLite view-state seam.
- `packages/github-actions/pipeline.ts` — polling, activation, discovery, subscriptions and lifecycle.
- `packages/github-actions/*.test.ts` — focused contract and state-machine tests.
- `packages/host/src/config.ts` — strict GitHub Actions configuration validation.
- `packages/host/src/runtime.ts` — construct and stop the pipeline module, then inject it into Presentation.
- `packages/host/src/presentation.ts` — generation-safe pipeline gesture activation and snapshot refresh.
- `packages/studio/document.ts` — declarative `github-pipeline` action and trusted validation context.
- `packages/presentation/button-compositor.ts` — runtime status band and detail overlay.
- `packages/presentation/render.ts` — resolve a button binding to a normalized snapshot.
- `packages/editor/server.ts` and `packages/editor/web/*` — credential-free pipeline catalog and action inspector.
- `scripts/register-crepe-github-actions.ts` — idempotent local development registration and page creation.
- `packages/host/src/github-actions.integration.test.ts` — full fake-gateway Runtime/Presentation flow.
- `README.md` and `DEVELOPMENT.md` — setup, auth, safety and validation instructions.

---

### Task 1: Trusted Pipeline Types and Configuration

**Files:**
- Create: `packages/github-actions/types.ts`
- Create: `packages/github-actions/crepe.ts`
- Create: `packages/github-actions/types.test.ts`
- Modify: `packages/host/src/config.ts`
- Modify: `packages/host/src/config.test.ts`

**Interfaces:**
- Consumes: existing `Config` validation and absolute-executable conventions.
- Produces: `PipelineDefinition`, `GitHubActionsConfig`, `PipelineButtonBinding`, `PipelineButtonSnapshot`, `GitHubActionsGateway`, `GitHubActionsPipeline`, `CREPE_PIPELINES`, and validated `Config.githubActions`.

- [ ] **Step 1: Write failing trusted-definition and configuration tests**

```ts
import {expect,test} from 'bun:test';
import {CREPE_PIPELINES,validatePipelineDefinitions} from './crepe';

test('Crepe definitions encode press RC, hold Prod and exact downstream contracts',()=>{
  const definitions=validatePipelineDefinitions(CREPE_PIPELINES);
  expect(definitions.map(item=>[item.id,item.trigger.gesture,item.deployment.workflow])).toEqual([
    ['crepe-backend-stg','press','release-backend.yaml'],
    ['crepe-backend-prod','hold','release-backend-prod.yaml'],
  ]);
  expect(definitions[0]!.deployment.approvalEnvironment).toBe('stg-backend');
});

test('definition validation rejects untrusted shapes',()=>{
  for(const mutate of [
    (value:any)=>{value[1].id=value[0].id;},
    (value:any)=>{value[0].repository='cookieplace/crepe;rm';},
    (value:any)=>{value[0].trigger.workflow='../cut-rc.yaml';},
    (value:any)=>{value[0].chain.anchorStep='';},
    (value:any)=>{value[0].chain.tagPattern='*';},
  ]){
    const value=structuredClone(CREPE_PIPELINES);mutate(value);
    expect(()=>validatePipelineDefinitions(value)).toThrow();
  }
});
```

Extend `packages/host/src/config.test.ts` so `validateConfig` accepts an absolute executable and the exact definitions, then rejects a relative executable, unknown keys, duplicate IDs, mismatched event/chain kinds, empty repository, invalid workflow filename, invalid ref, more than 16 inputs, and non-string inputs.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun test packages/github-actions/types.test.ts packages/host/src/config.test.ts`

Expected: FAIL because `packages/github-actions/types.ts`, `crepe.ts`, and `Config.githubActions` do not exist.

- [ ] **Step 3: Define the complete trusted interfaces**

```ts
export type PipelineState='idle'|'dispatching'|'queued'|'running'|'approval-required'|'succeeded'|'no-change'|'failed'|'cancelled'|'unavailable';
export type PipelineButtonRole='trigger'|'deployment';
export type PipelineGesture='press'|'hold';
export type PipelineButtonBinding={pipelineId:string;role:PipelineButtonRole};
export type PipelineButtonSnapshot={binding:PipelineButtonBinding;state:PipelineState;detail:string;color:string;runUrl?:string};

export type PipelineDefinition={
  id:string;repository:string;ref:string;
  trigger:{workflow:string;inputs:Record<string,string>;gesture:PipelineGesture};
  chain:{kind:'tag-push'|'release-published';anchorJob:string;anchorStep:string;tagPattern:string};
  deployment:{workflow:string;event:'push'|'release';approvalEnvironment?:string};
};
export type GitHubActionsConfig={executable:string;pipelines:PipelineDefinition[]};

export type GitHubWorkflowRun={id:number;workflowId:number;url:string;event:string;headBranch:string;headSha:string;status:string;conclusion:string|null;createdAt:string;updatedAt:string;actor:string};
export type GitHubStep={name:string;status:string;conclusion:string|null;startedAt:string|null;completedAt:string|null};
export type GitHubJob={id:number;name:string;url:string;status:string;conclusion:string|null;startedAt:string|null;completedAt:string|null;steps:GitHubStep[]};
export type GitHubRunDetails=GitHubWorkflowRun&{jobs:GitHubJob[]};
export type GitHubPendingDeployment={environment:{id:number;name:string;htmlUrl:string};currentUserCanApprove:boolean};
export type GitHubRelease={id:number;tagName:string;targetCommitish:string;publishedAt:string;url:string};

export interface GitHubActionsGateway{
  viewer(signal?:AbortSignal):Promise<string>;
  dispatch(definition:PipelineDefinition,signal?:AbortSignal):Promise<string|undefined>;
  listRuns(repository:string,workflow:string,signal?:AbortSignal):Promise<GitHubWorkflowRun[]>;
  getRun(repository:string,runId:number,signal?:AbortSignal):Promise<GitHubRunDetails>;
  pendingDeployments(repository:string,runId:number,signal?:AbortSignal):Promise<GitHubPendingDeployment[]>;
  listReleases(repository:string,signal?:AbortSignal):Promise<GitHubRelease[]>;
  open(repository:string,url:string,signal?:AbortSignal):Promise<void>;
}
export interface GitHubActionsPipeline{
  snapshot():readonly PipelineButtonSnapshot[];
  activate(binding:PipelineButtonBinding,gesture:PipelineGesture,signal:AbortSignal):Promise<void>;
  subscribe(listener:()=>void):()=>void;
  stop():Promise<void>;
}
```

- [ ] **Step 4: Add exact Crepe definitions and validators**

`CREPE_PIPELINES` must contain `cut-rc.yaml` with `{force-bump:'auto'}`, job `cut-rc`, step `Push rc tag`, and `release-backend.yaml`; the production definition must contain no inputs, job `cut-release`, step `Create release`, and `release-backend-prod.yaml`. Convert tag globs to anchored internal regular expressions without accepting arbitrary regex from Studio.

```ts
export const CREPE_PIPELINES:readonly PipelineDefinition[]=[
  {id:'crepe-backend-stg',repository:'cookieplace/crepe',ref:'develop',trigger:{workflow:'cut-rc.yaml',inputs:{'force-bump':'auto'},gesture:'press'},chain:{kind:'tag-push',anchorJob:'cut-rc',anchorStep:'Push rc tag',tagPattern:'backend/v*.*.*-rc.*'},deployment:{workflow:'release-backend.yaml',event:'push',approvalEnvironment:'stg-backend'}},
  {id:'crepe-backend-prod',repository:'cookieplace/crepe',ref:'develop',trigger:{workflow:'backend-release-cut-prod.yaml',inputs:{},gesture:'hold'},chain:{kind:'release-published',anchorJob:'cut-release',anchorStep:'Create release',tagPattern:'backend/v*.*.*'},deployment:{workflow:'release-backend-prod.yaml',event:'release'}},
];
```

- [ ] **Step 5: Extend strict host configuration validation**

Add optional `githubActions?: GitHubActionsConfig` to `Config`. Validate exact keys, an absolute executable, at most 16 pipelines, and deep-clone the accepted definitions. Return the normalized configuration without adding GitHub Actions to default configs.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `bun test packages/github-actions/types.test.ts packages/host/src/config.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the trusted configuration seam**

```bash
git add packages/github-actions/types.ts packages/github-actions/crepe.ts packages/github-actions/types.test.ts packages/host/src/config.ts packages/host/src/config.test.ts
git commit -m "feat(github-actions): validate trusted pipelines"
```

---

### Task 2: Bounded GitHub CLI Adapter

**Files:**
- Create: `packages/github-actions/cli.ts`
- Create: `packages/github-actions/cli.test.ts`
- Modify: `packages/actions/system.ts`
- Modify: `packages/actions/system.test.ts`

**Interfaces:**
- Consumes: Task 1 `GitHubActionsGateway` and existing `runBoundedProcess(ProcessRequest, AbortSignal)`.
- Produces: `createGitHubCliGateway(options):GitHubActionsGateway` and a reusable sanitized process error code that does not expose stderr.

- [ ] **Step 1: Write failing argv and normalization tests with an injected process runner**

```ts
test('dispatch uses literal argv and returns only a validated run URL',async()=>{
  const calls:ProcessRequest[]=[];
  const gateway=createGitHubCliGateway({executable:'/opt/homebrew/bin/gh',runProcess:async request=>{calls.push(request);return{stdout:'https://github.com/cookieplace/crepe/actions/runs/123\n',stderr:'',exitCode:0};}});
  expect(await gateway.dispatch(CREPE_PIPELINES[0]!)).toBe('https://github.com/cookieplace/crepe/actions/runs/123');
  expect(calls[0]!.argv).toEqual(['/opt/homebrew/bin/gh','workflow','run','cut-rc.yaml','--repo','cookieplace/crepe','--ref','develop','-f','force-bump=auto']);
});

test('adapter rejects a foreign URL and never returns raw stderr',async()=>{
  const foreign=createGitHubCliGateway({executable:'/opt/homebrew/bin/gh',runProcess:async()=>({stdout:'https://evil.example/run/1',stderr:'secret',exitCode:0})});
  await expect(foreign.dispatch(CREPE_PIPELINES[0]!)).rejects.toThrow('Invalid GitHub response');
  const failed=createGitHubCliGateway({executable:'/opt/homebrew/bin/gh',runProcess:async()=>{throw new Error('token=secret');}});
  await expect(failed.viewer()).rejects.toThrow('GitHub command failed');
});
```

Add fixtures for `run list`, `run view --json jobs`, pending deployments, releases, malformed JSON, unknown status strings, duplicate job IDs, invalid timestamps, control characters, cancellation, timeout and output-limit errors.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `bun test packages/github-actions/cli.test.ts packages/actions/system.test.ts`

Expected: FAIL because `createGitHubCliGateway` does not exist.

- [ ] **Step 3: Add a redacted bounded-process failure mode**

Add an option to `runBoundedProcess` or a small exported wrapper that maps non-zero exit, timeout and output overflow to stable error codes while retaining existing callers' behavior. GitHub-facing errors must be one of `cancelled`, `timeout`, `output-limit`, `process-failed`, or `invalid-response`; messages must not include stderr.

- [ ] **Step 4: Implement strict CLI commands**

Use only these literal command families. Read run data through `gh api` so the REST `actor.login` field is available for dispatch fallback correlation:

```ts
const commands={
  viewer:[executable,'api','user'],
  runs:(repo:string,workflow:string)=>[executable,'api',`repos/${repo}/actions/workflows/${workflow}/runs?per_page=30`],
  run:(repo:string,id:number)=>[executable,'api',`repos/${repo}/actions/runs/${id}`],
  jobs:(repo:string,id:number)=>[executable,'api',`repos/${repo}/actions/runs/${id}/jobs?per_page=100`],
  pending:(repo:string,id:number)=>[executable,'api',`repos/${repo}/actions/runs/${id}/pending_deployments`],
  releases:(repo:string)=>[executable,'api',`repos/${repo}/releases?per_page=30`],
};
```

All reads use `timeoutMs:10_000,maxOutputBytes:1_048_576`; dispatch uses `timeoutMs:60_000`. Parse JSON through field-by-field validators and discard every field not represented by Task 1 types.

- [ ] **Step 5: Implement URL opening through the existing process seam**

Accept only `https://github.com/${repository}/actions/`, `https://github.com/${repository}/releases/`, or the workflow page under the same repository. Execute `['/usr/bin/open',validatedUrl]` with a 3-second timeout and 4 KiB output cap.

- [ ] **Step 6: Run adapter tests and typecheck**

Run: `bun test packages/github-actions/cli.test.ts packages/actions/system.test.ts && bun run typecheck`

Expected: PASS with no real `gh` process started.

- [ ] **Step 7: Commit the adapter**

```bash
git add packages/github-actions/cli.ts packages/github-actions/cli.test.ts packages/actions/system.ts packages/actions/system.test.ts
git commit -m "feat(github-actions): add bounded gh adapter"
```

---

### Task 3: Pure Correlation, Persistence, and Pipeline Lifecycle

**Files:**
- Create: `packages/github-actions/state.ts`
- Create: `packages/github-actions/state.test.ts`
- Create: `packages/github-actions/store.ts`
- Create: `packages/github-actions/store.test.ts`
- Create: `packages/github-actions/pipeline.ts`
- Create: `packages/github-actions/pipeline.test.ts`
- Modify: `packages/host/src/store.ts`
- Modify: `packages/host/src/store.test.ts`

**Interfaces:**
- Consumes: Task 1 definitions and Task 2 gateway.
- Produces: `normalizeRunState`, `firstFailureUrl`, `matchTagPushRun`, `matchPublishedRelease`, `matchReleaseRun`, `PipelinePersistence`, `SignalStorePipelinePersistence`, and `startGitHubActionsPipeline(options):Promise<GitHubActionsPipeline>`.

- [ ] **Step 1: Write failing pure-state tests**

```ts
test('pending stg environment overrides an in-progress run',()=>{
  expect(normalizeRunState(run({status:'in_progress'}),[{environment:{id:1,name:'stg-backend',htmlUrl:'https://github.com/cookieplace/crepe/deployments'},currentUserCanApprove:true}],'stg-backend')).toBe('approval-required');
});

test('firstFailureUrl chooses the earliest failed job then falls back to the run',()=>{
  const details=runDetails({url:'https://github.com/cookieplace/crepe/actions/runs/9',jobs:[job(2,'failure','2026-09-21T02:00:00Z'),job(1,'failure','2026-09-21T01:00:00Z')]});
  expect(firstFailureUrl(details)).toContain('/job/1');
  expect(firstFailureUrl({...details,jobs:[]})).toBe(details.url);
});
```

Cover every common state, `Push rc tag` skipped, exact anchor job/step, wrong workflow/event/SHA/tag, ambiguous candidates, a new Release not in baseline, release target SHA, and the 90-second correlation deadline.

- [ ] **Step 2: Run state tests and verify RED**

Run: `bun test packages/github-actions/state.test.ts`

Expected: FAIL because the pure functions do not exist.

- [ ] **Step 3: Implement deterministic state functions**

Map `queued|requested|pending|waiting` to `queued`, `in_progress` to `running`, completed success to `succeeded`, `cancelled` to `cancelled`, and every other completed non-success conclusion to `failed`. Only a nonempty pending-deployment result whose environment name exactly equals the trusted configured name becomes `approval-required`.

Correlation functions return `{kind:'matched',value}`, `{kind:'pending'}`, `{kind:'none'}`, or `{kind:'ambiguous'}` so callers cannot silently take the first candidate.

- [ ] **Step 4: Write failing persistence tests**

```ts
test('pipeline state is isolated in view_state and invalid stored JSON is ignored',()=>{
  const store=new SignalStore(':memory:');
  const persistence=new SignalStorePipelinePersistence(store);
  persistence.save('crepe-backend-stg',{version:1,triggerRunId:12,lastSuccessAt:1000});
  expect(persistence.load('crepe-backend-stg')).toMatchObject({triggerRunId:12});
  store.setViewState('github-actions/other',{version:99,token:'must-not-surface'});
  expect(persistence.load('other')).toBeUndefined();
  store.close();
});
```

- [ ] **Step 5: Implement versioned, bounded stored state**

Persist only `version`, numeric run/release IDs, validated URLs, tag, SHA, timestamps, baseline release IDs, and the last normalized state. Reject more than 30 baseline IDs and strings over their declared limits. Do not persist jobs, reviewer lists, CLI output, API errors, or credentials.

```ts
export type StoredPipelineState={version:1;triggerRunId?:number;deploymentRunId?:number;releaseId?:number;runUrl?:string;failureUrl?:string;tag?:string;sha?:string;startedAt?:string;lastState?:PipelineState;lastSuccessAt?:number;baselineReleaseIds?:number[]};
export interface PipelinePersistence{
  load(pipelineId:string):StoredPipelineState|undefined;
  save(pipelineId:string,state:StoredPipelineState):void;
}
```

- [ ] **Step 6: Write failing lifecycle and activation tests with fake clock/gateway**

Cover initial discovery, exact stored-run refresh, RC dispatch, active-run duplicate suppression, RC no-change, tag-push chain, production press-open, production hold-dispatch, release chain, Stg approval, success, failure URL, network backoff `5s→10s→20s→40s→60s`, 10-second active polling, 30-second approval polling, 60-second idle polling, no overlapping poll, subscriber changes only, cancellation and idempotent stop.

```ts
expect(await pipeline.activate({pipelineId:'crepe-backend-prod',role:'trigger'},'press',signal)).toBeUndefined();
expect(gateway.dispatches).toHaveLength(0);
expect(gateway.opened.at(-1)).toContain('/actions/runs/');
await pipeline.activate({pipelineId:'crepe-backend-prod',role:'trigger'},'hold',signal);
expect(gateway.dispatches).toHaveLength(1);
```

- [ ] **Step 7: Implement the deep pipeline module**

`startGitHubActionsPipeline` accepts definitions, gateway, persistence, clock and scheduler dependencies. Its async factory performs one bounded refresh before returning. `activate` enforces the configured gesture, opens an active run instead of dispatching a duplicate, and opens the deployment run or trigger fallback for monitor buttons. Every state mutation persists before notifying subscribers.

```ts
export async function startGitHubActionsPipeline(options:{
  definitions:readonly PipelineDefinition[];
  gateway:GitHubActionsGateway;
  persistence:PipelinePersistence;
  now?:()=>number;
  schedule?:(delayMs:number,callback:()=>void)=>{cancel():void};
  onError?:(error:unknown)=>void;
}):Promise<GitHubActionsPipeline>;
```

- [ ] **Step 8: Run the entire module suite**

Run: `bun test packages/github-actions/state.test.ts packages/github-actions/store.test.ts packages/github-actions/pipeline.test.ts packages/host/src/store.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 9: Commit pipeline state and lifecycle**

```bash
git add packages/github-actions/state.ts packages/github-actions/state.test.ts packages/github-actions/store.ts packages/github-actions/store.test.ts packages/github-actions/pipeline.ts packages/github-actions/pipeline.test.ts packages/host/src/store.ts packages/host/src/store.test.ts
git commit -m "feat(github-actions): track release pipelines"
```

---

### Task 4: Studio Action and Credential-Free Catalog

**Files:**
- Modify: `packages/studio/document.ts`
- Modify: `packages/studio/document.test.ts`
- Modify: `packages/editor/server.ts`
- Modify: `packages/editor/server.test.ts`
- Modify: `packages/editor/web/state.ts`
- Modify: `packages/editor/web/action-library.ts`
- Modify: `packages/editor/web/inspector-view.ts`
- Modify: `packages/editor/web/model.test.ts`
- Modify: `packages/editor/web/canvas-view.ts`
- Modify: `packages/editor/web/canvas-view.test.ts`

**Interfaces:**
- Consumes: Task 1 pipeline IDs and roles.
- Produces: `ButtonAction {type:'github-pipeline';pipelineId;role}`, `StudioValidationContext.pipelines`, `/api/catalog/github-pipelines`, editor catalog state and inspector controls.

- [ ] **Step 1: Write failing Studio document tests**

```ts
test('validates trusted pipeline actions on press and hold',()=>{
  const document=defaultStudioDocument();
  document.pages[0].buttons=[{id:'prod',index:0,behavior:{
    press:{type:'single',action:{type:'github-pipeline',pipelineId:'crepe-backend-prod',role:'trigger'}},
    hold:{type:'single',action:{type:'github-pipeline',pipelineId:'crepe-backend-prod',role:'trigger'}},
    doublePressMs:300,holdMs:700,
  },appearance:{contentMode:'label-only',label:{text:'Prod 승격',position:'center',size:'medium',color:'#ffffff'}}}];
  expect(validateStudioDocument(document,{pipelines:[{id:'crepe-backend-prod'}]}).pages[0].buttons).toHaveLength(1);
  expect(()=>validateStudioDocument(document,{pipelines:[]})).toThrow('Unknown GitHub pipeline');
});
```

Also reject pipeline actions inside sequence/toggle programs, different pipeline bindings on press and hold of one button, deployment bindings on hold, unknown roles, extra fields and missing pipeline context.

- [ ] **Step 2: Run document tests and verify RED**

Run: `bun test packages/studio/document.test.ts`

Expected: FAIL because `github-pipeline` is not a valid action.

- [ ] **Step 3: Extend the document contract minimally**

Add the union member and context lookup. Allow only a `single` program for this action. After a button validates, gather all pipeline actions in its behavior and require identical `{pipelineId,role}`. The configured gesture remains Runtime-owned; Studio may show both press and hold branches only for the same binding.

- [ ] **Step 4: Write failing editor server and view-model tests**

Assert bootstrap/catalog output contains only `{id,label,roles}` and never repository, workflow, executable or inputs. Assert the action library creates a label-only pipeline button, the inspector changes pipeline/role, copy-paste preserves the binding, and canvas badge text is `GITHUB`.

- [ ] **Step 5: Add the catalog route and browser state**

`GET /api/catalog/github-pipelines` requires the existing editor capability header and returns:

```ts
type GitHubPipelineCatalogItem={id:string;label:string;roles:('trigger'|'deployment')[]};
```

The server derives labels `Crepe Backend Stg` and `Crepe Backend Prod` from trusted definitions supplied at startup. `StudioState.connect` fetches this catalog beside apps and registered actions.

- [ ] **Step 6: Add action-library and inspector controls**

Add one available `GitHub Actions` item in the `기본` group. Creating it selects the first pipeline and `trigger`. The inspector renders selects labelled `파이프라인` and `역할`, with roles displayed as `실행` and `배포 상태`. It does not expose workflow input editing.

- [ ] **Step 7: Run Studio and editor tests**

Run: `bun test packages/studio/document.test.ts packages/editor/server.test.ts packages/editor/web/model.test.ts packages/editor/web/canvas-view.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the Studio contract**

```bash
git add packages/studio/document.ts packages/studio/document.test.ts packages/editor/server.ts packages/editor/server.test.ts packages/editor/web/state.ts packages/editor/web/action-library.ts packages/editor/web/inspector-view.ts packages/editor/web/model.test.ts packages/editor/web/canvas-view.ts packages/editor/web/canvas-view.test.ts
git commit -m "feat(studio): author GitHub pipeline buttons"
```

---

### Task 5: Pipeline Status Rendering and Generation-Safe Gestures

**Files:**
- Modify: `packages/presentation/button-compositor.ts`
- Modify: `packages/presentation/button-compositor.test.ts`
- Modify: `packages/presentation/render.ts`
- Modify: `packages/presentation/render.test.ts`
- Modify: `packages/streamdeck/pages.ts`
- Modify: `packages/streamdeck/pages.test.ts`
- Modify: `packages/host/src/presentation.ts`
- Modify: `packages/host/src/presentation.test.ts`

**Interfaces:**
- Consumes: Task 3 `GitHubActionsPipeline` snapshots and Task 4 `github-pipeline` actions.
- Produces: status-band rendering, snapshot lookup by binding, and press/hold activation through Presentation.

- [ ] **Step 1: Write failing compositor and renderer tests**

```ts
test('pipeline runtime paints a seven-pixel status band without replacing authored content',async()=>{
  const png=await composeButton({appearance:labelOnly('Stg 배포'),background:opaqueBackground(),assets:emptyAssets,runtime:{detail:'승인 대기',statusColor:'#f59e0b'}});
  const pixels=await sharp(png).raw().toBuffer();
  expect([...pixels.subarray(0,3)]).toEqual([245,158,11]);
});
```

Renderer tests must prove an `approval-required` snapshot supplies `승인 대기` and orange, a failed snapshot supplies red, no snapshot supplies `확인 불가`, and ordinary buttons retain their current pixels.

- [ ] **Step 2: Run render tests and verify RED**

Run: `bun test packages/presentation/button-compositor.test.ts packages/presentation/render.test.ts`

Expected: FAIL because runtime status colors and pipeline lookup do not exist.

- [ ] **Step 3: Add a bounded status layer**

Extend compositor runtime with `statusColor?:string`. Validate `^#[0-9a-f]{6}$`, draw only the top seven pixels, retain authored icon/label/background layers, and keep hidden buttons visually hidden. Pass the pipeline detail through the existing escaped text path.

- [ ] **Step 4: Project pipeline buttons as fixed text tiles**

In `studioDocumentToPageConfig`, project `github-pipeline` to a non-executable text tile for layout only. Production input still comes from the Studio button behavior in Presentation, so `PageBoard` must not dispatch GitHub effects.

- [ ] **Step 5: Write failing Presentation gesture tests**

Use a fake `GitHubActionsPipeline` and backend. Assert RC press produces one `{pipelineId:'crepe-backend-stg',role:'trigger'},'press'`; Prod press produces only an open activation; a 700ms hold produces one `'hold'`; stale generation, lock, page change, document apply and stop abort or suppress activation. Assert a pipeline snapshot refresh republishes once and a locked refresh waits until unlock.

- [ ] **Step 6: Integrate pipeline state into rendering**

Extend `DeckVisualRenderer.render` state with:

```ts
pipeline(binding:PipelineButtonBinding):PipelineButtonSnapshot|undefined;
```

Find the single validated pipeline binding in a fixed button's behavior, keep the authored label, and provide snapshot `detail` and `color` to the compositor.

- [ ] **Step 7: Integrate pipeline activation into Presentation**

Add optional `pipelines?:GitHubActionsPipeline` to `startPresentationCoordinator`. Pass the emitted gesture into `executeBehavior`. For a single `github-pipeline` action, call `pipelines.activate(binding,gesture,signal)` and do not set `PageBoard` local action status. Subscribe at startup; on notification publish `refresh` only when unlocked. Unsubscribe and abort activation on stop.

- [ ] **Step 8: Run Presentation suites and typecheck**

Run: `bun test packages/presentation/button-compositor.test.ts packages/presentation/render.test.ts packages/streamdeck/pages.test.ts packages/host/src/presentation.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 9: Commit rendering and gestures**

```bash
git add packages/presentation/button-compositor.ts packages/presentation/button-compositor.test.ts packages/presentation/render.ts packages/presentation/render.test.ts packages/streamdeck/pages.ts packages/streamdeck/pages.test.ts packages/host/src/presentation.ts packages/host/src/presentation.test.ts
git commit -m "feat(streamdeck): render tracked GitHub pipelines"
```

---

### Task 6: Runtime Ownership, Discovery, and Clean Shutdown

**Files:**
- Modify: `packages/host/src/runtime.ts`
- Modify: `packages/host/src/runtime.test.ts`
- Modify: `packages/editor/server.ts`
- Modify: `packages/editor/server.test.ts`
- Modify: `packages/studio/repository.ts`
- Modify: `packages/studio/repository.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 production gateway, pipeline factory, persistence and Studio context.
- Produces: one Runtime-owned pipeline lifecycle and consistent validation/catalog contexts in Runtime and Studio.

- [ ] **Step 1: Write failing Runtime lifecycle tests**

Assert startup order `store → pipeline → backend → presentation → server`, pipeline injection into Presentation, rollback after pipeline startup failure, pipeline stop before store close, cleanup aggregation, no pipeline construction when config omits the integration, and abort during initial discovery.

```ts
expect(calls).toEqual(['store-open','pipeline-open','backend-open','presentation-open','server-open']);
await runtime.stop();
expect(calls.slice(-4)).toEqual(['presentation-stop','backend-stop','pipeline-stop','store-close']);
```

- [ ] **Step 2: Run Runtime tests and verify RED**

Run: `bun test packages/host/src/runtime.test.ts packages/editor/server.test.ts packages/studio/repository.test.ts`

Expected: FAIL because Runtime has no pipeline dependency.

- [ ] **Step 3: Add injected Runtime factories**

Extend `HostDependencies` with a pipeline factory and pass `{definitions,gateway,persistence,onError}`. Production creates `GitHubCliAdapter` with `config.githubActions.executable`; tests supply a fake. Start it after SQLite opens so recovery can load, and before Presentation so the first rendered surface has a snapshot.

- [ ] **Step 4: Share trusted validation context**

Construct one `StudioValidationContext` containing registered actions, assets and pipeline IDs. Pass it to the Runtime `StudioRepository`, editor-side `StudioRepository`, draft validation, apply validation and preview-safe catalog. A document referencing an unconfigured pipeline must fail at load/apply rather than render as a dead button.

- [ ] **Step 5: Preserve poller failures without killing Runtime**

Invalid trusted configuration or a missing/non-executable configured `gh` path stops startup. Initial and later network/auth query failures become `unavailable` snapshots and call `onError` with a bounded public error, but do not stop Runtime. An unexpected invariant failure reports and stops only the pipeline module, leaving normal buttons usable.

- [ ] **Step 6: Run lifecycle tests and full host/editor suites**

Run: `bun test packages/host/src/runtime.test.ts packages/editor/server.test.ts packages/studio/repository.test.ts packages/host/src/presentation.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit Runtime ownership**

```bash
git add packages/host/src/runtime.ts packages/host/src/runtime.test.ts packages/editor/server.ts packages/editor/server.test.ts packages/studio/repository.ts packages/studio/repository.test.ts
git commit -m "feat(runtime): own GitHub pipeline tracking"
```

---

### Task 7: Idempotent Crepe Registration and Local Page

**Files:**
- Create: `scripts/register-crepe-github-actions.ts`
- Create: `scripts/register-crepe-github-actions.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `DEVELOPMENT.md`

**Interfaces:**
- Consumes: Task 1 `CREPE_PIPELINES`, validated config updates and Studio v3 repository/document helpers.
- Produces: `bun run github:register-crepe` and an idempotent `crepe-release` page in the current development document.

- [ ] **Step 1: Write failing registration tests in temporary directories**

Cover missing config initialization, preserving tokens/display/actions/collectors, absolute `gh` discovery, refusing missing or unauthenticated `gh`, preserving existing pages/buttons/assets, adding exactly one `crepe-release` page, adding one reachable `next-page` button to the prior last page, idempotent rerun, updating both applied document and a valid draft, refusing an occupied conflicting page ID or a prior page with no free navigation key, and never invoking workflow dispatch.

```ts
expect(result.document.pages.find(page=>page.id==='crepe-release')?.buttons?.map(button=>button.appearance.label?.text)).toEqual(['RC 컷','Stg 배포','Prod 승격','Prod 배포','이전 페이지']);
expect(spawned.every(argv=>!argv.includes('workflow'))).toBe(true);
```

- [ ] **Step 2: Run registration tests and verify RED**

Run: `bun test scripts/register-crepe-github-actions.test.ts`

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement pure page construction**

Use indices `0,1,5,6` for the four buttons and `10` for previous-page navigation. RC uses a press single action. Stg and Prod deployment use press single actions. Prod trigger uses identical press and hold pipeline bindings with `holdMs:700`; the pipeline module interprets press as open and hold as dispatch. Add a `next-page` action to the former last page at the first free index in `[14,13,12,11,9,8,7,6,5,4,3,2,1,0]`; if none is free, leave the document unchanged and report the problem. Use label-only appearances with neutral authored backgrounds so runtime status colors remain visible.

- [ ] **Step 4: Implement safe local registration**

Resolve `gh` with `Bun.which('gh')`, require an absolute path, call only `gh auth status --hostname github.com` with the bounded runner, then update config atomically. Use `StudioRepository.snapshot/apply` with pipeline context. If `.streamhub/studio/draft.json` is valid, apply the same pure page transform and publish it atomically; if invalid, leave it untouched and report its path.

- [ ] **Step 5: Document setup and safety**

Add these development instructions:

```sh
gh auth status --hostname github.com
bun run github:register-crepe
bun start
bun run editor
```

State that registration never dispatches, Stg approval remains in GitHub, RC press dispatches, Prod requires a 700ms hold, and the status buttons open failed jobs.

- [ ] **Step 6: Run registration and documentation tests**

Run: `bun test scripts/register-crepe-github-actions.test.ts scripts/release-docs.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit registration and documentation**

```bash
git add scripts/register-crepe-github-actions.ts scripts/register-crepe-github-actions.test.ts package.json README.md DEVELOPMENT.md
git commit -m "feat: register Crepe release controls"
```

---

### Task 8: Vertical Integration, Packaging, and Final Verification

**Files:**
- Create: `packages/host/src/github-actions.integration.test.ts`
- Modify: `scripts/package.test.ts`
- Modify: `scripts/packaged-studio.test.ts`
- Modify: `docs/validation/studio-advanced-actions.md`

**Interfaces:**
- Consumes: every previous task.
- Produces: end-to-end regression evidence, packaged inclusion and the locally registered four-button page.

- [ ] **Step 1: Write the full fake-gateway integration test**

Start an in-memory store, fake backend, Presentation and fake GitHub gateway. Drive this exact RC sequence: press → trigger queued → running → `Push rc tag` success → Stg run → pending `stg-backend` → approval cleared → deploy failure. Assert rendered status hashes change at each state, activation counts stay one, and the final monitor press opens the failed job URL. Restart using the same persisted state and assert the exact Stg run is resumed.

- [ ] **Step 2: Add the production sequence integration test**

Drive press on Prod trigger and assert only open; drive 699ms and release and assert no dispatch; drive a 700ms hold and assert one dispatch; then `Create release` → one new backend Release → release event run → success. Add ambiguous Release and ambiguous run cases and assert `unavailable`, not a guessed deployment.

- [ ] **Step 3: Run integration tests and verify GREEN**

Run: `bun test packages/host/src/github-actions.integration.test.ts`

Expected: PASS without executing `gh`, `/usr/bin/open`, or a real workflow.

- [ ] **Step 4: Verify packaged sources and browser bundle**

Extend package tests to require `app/packages/github-actions/*.ts`, reject test fixtures, and load the packaged Studio browser bundle containing the new catalog/editor paths. Add `github-actions` to `runtimeSourceDirectories` in `scripts/package.ts`.

- [ ] **Step 5: Run focused and full automated gates**

Run:

```sh
bun test packages/github-actions packages/host/src/github-actions.integration.test.ts packages/host/src/presentation.test.ts packages/studio/document.test.ts packages/editor/server.test.ts packages/presentation/button-compositor.test.ts packages/presentation/render.test.ts scripts/register-crepe-github-actions.test.ts
bun run check
bun run streamdeck:plugin:check
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 6: Register the current local development page**

Run: `bun run github:register-crepe`

Expected: config reports two trusted pipelines and the current Studio document contains one `crepe-release` page with the four requested buttons. This command must not print a token or dispatch a workflow.

- [ ] **Step 7: Perform read-only authenticated smoke checks**

Run:

```sh
gh auth status --hostname github.com
gh run list --repo cookieplace/crepe --workflow release-backend.yaml --limit 1 --json databaseId,status,conclusion,url
gh api repos/cookieplace/crepe/actions/runs/$(gh run list --repo cookieplace/crepe --workflow release-backend.yaml --limit 1 --json databaseId --jq '.[0].databaseId')/pending_deployments
```

Expected: authentication succeeds, the latest run parses, and pending deployments returns a JSON array. Do not call `gh workflow run` during smoke verification.

- [ ] **Step 8: Record validation and commit**

Update `docs/validation/studio-advanced-actions.md` with automated command results, the read-only smoke result, and an explicit note that real dispatch and physical-device acceptance remain unperformed unless the user separately asks for them.

```bash
git add packages/host/src/github-actions.integration.test.ts scripts/package.ts scripts/package.test.ts scripts/packaged-studio.test.ts docs/validation/studio-advanced-actions.md
git commit -m "test: verify GitHub release controls"
```

- [ ] **Step 9: Run the final verification snapshot**

Run: `git status --short && git log -9 --oneline --decorate && bun run check && bun run streamdeck:plugin:check && git diff --check`

Expected: only intentionally ignored local `.streamhub` changes remain outside git status, all gates exit 0, and the branch contains the design, plan and implementation commits.
