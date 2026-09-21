# GitHub Actions 파이프라인 버튼 설계

- 날짜: 2026-09-21
- 상태: 대화에서 승인된 구조를 구현 전 문서화
- 대상 저장소: `cookieplace/crepe`
- 구현 저장소: Streamhub

## 1. 목표

Stream Deck 한 페이지에서 Crepe 백엔드의 RC 컷과 Prod 승격을 실행하고, 각각이 시작하는 실제 Stg·Prod 배포를 별도 버튼으로 추적한다.

기본 배치는 네 버튼이다.

```text
[ RC 컷 실행 ]   [ Stg 배포 상태 ]
[ Prod 승격 ]    [ Prod 배포 상태 ]
```

사용자는 다음을 할 수 있어야 한다.

1. `cut-rc.yaml`을 짧게 눌러 실행한다.
2. 이어진 `release-backend.yaml`의 리포트·빌드, `stg-backend` 승인 대기, 배포, 성공·실패를 별도 버튼에서 본다.
3. `backend-release-cut-prod.yaml`을 길게 눌러 실행한다.
4. 이어진 `release-backend-prod.yaml`의 실제 Prod 배포를 별도 버튼에서 본다.
5. 승인 대기 버튼을 눌러 GitHub 승인 화면으로 이동한다.
6. 실패한 상태 버튼을 눌러 최초 실패 job 화면으로 바로 이동한다.
7. Runtime 재시작 뒤에도 추적하던 실행을 복구한다.

## 2. 확인된 워크플로 계약

| 역할 | 워크플로 | 트리거 | 후속 연결 |
|---|---|---|---|
| RC 컷 | `.github/workflows/cut-rc.yaml` | `workflow_dispatch`, `force-bump=auto` | `backend/vX.Y.Z-rc.N` 태그 push |
| Stg 배포 | `.github/workflows/release-backend.yaml` | `backend/v*.*.*-rc.*` 태그 push | `stg-backend` Environment 승인 뒤 두 배포 job 실행 |
| Prod 승격 | `.github/workflows/backend-release-cut-prod.yaml` | `workflow_dispatch`, 빈 `rc-tag` | GitHub Release published |
| Prod 배포 | `.github/workflows/release-backend-prod.yaml` | backend Release published | Backend와 Admin Backend 배포 |

`release-backend.yaml`의 `deploy-backend`와 `deploy-admin-backend`는 모두 `environment: stg-backend`를 사용한다. 동일 Environment에 대한 한 번의 승인이 두 job을 함께 해제한다. 승인 여부는 run이나 job 상태를 추측해서 만들지 않고 `GET /repos/cookieplace/crepe/actions/runs/{run_id}/pending_deployments`의 `stg-backend` 항목 존재 여부로 판정한다.

Crepe 워크플로 파일은 이 기능을 위해 수정하지 않는다.

## 3. 범위 밖

- Stream Deck에서 Stg 배포를 승인하거나 거부하지 않는다.
- 워크플로 재실행, 취소 또는 특정 실패 job 재실행을 제공하지 않는다.
- GitHub 토큰을 Streamhub 설정, Studio 문서 또는 SQLite에 저장하지 않는다.
- GitHub 웹훅 수신을 위해 로컬 Runtime을 외부에 공개하지 않는다.
- 범용 동적 데이터 영역 전체를 먼저 구현하지 않는다.
- Crepe 외 다른 저장소용 자동 설정 UI는 이번 범위에 포함하지 않는다. 내부 정의는 재사용 가능하게 만들되 첫 설정은 Crepe 두 파이프라인으로 제한한다.

## 4. 사용자 동작

### 4.1 RC 컷 실행 버튼

- 짧게 누르면 `cut-rc.yaml`을 `develop`, `force-bump=auto`로 실행한다.
- 이미 같은 RC 컷 run이 진행 중이면 중복 실행하지 않고 현재 run을 연다.
- 버튼은 `요청 중`, `대기`, `실행 중`, `완료`, `실패`, `변경 없음`, `확인 불가`를 표시한다.
- 완료·실패 뒤 다시 짧게 누르면 새 실행을 시작한다. 기존 실행 상세는 Stg 상태 버튼이 downstream run이 없을 때 trigger run으로 대체해 연다.
- RC 컷이 `Push rc tag` 단계를 건너뛰면 성공한 배포로 오해하지 않고 `변경 없음`으로 표시하며 Stg 추적을 시작하지 않는다.

### 4.2 Stg 배포 상태 버튼

- 실행 동작은 없고 현재 또는 가장 최근의 `release-backend.yaml` run을 연다.
- downstream run이 아직 없고 RC trigger가 실패·진행 중이면 그 trigger 상태와 URL을 대신 보여 준다.
- pending deployments에 `stg-backend`가 있으면 `승인 대기`를 최우선으로 표시한다.
- 승인 대기 중 누르면 run 페이지를 연다. GitHub의 `Review deployments` UI에서만 승인한다.
- 실패 시 누르면 실패 conclusion을 가진 첫 job URL을 연다. 실패 job URL을 얻지 못하면 run URL로 대체한다.
- 승인 거부로 실패하고 실패 job URL이 없으면 run URL을 연다.

### 4.3 Prod 승격 버튼

- 짧게 누르면 현재 또는 가장 최근 `backend-release-cut-prod.yaml` run을 연다.
- 길게 누를 때만 `backend-release-cut-prod.yaml`을 `develop`에서 실행한다. 선택 입력 `rc-tag`는 생략해 워크플로가 최신 RC를 고르게 한다.
- 진행 중인 동일 승격 run이 있으면 길게 눌러도 중복 실행하지 않고 현재 run을 연다.
- 기존 Studio의 hold gesture와 `holdMs` 계약을 재사용한다. 기본 hold 시간은 700ms로 설정한다.

### 4.4 Prod 배포 상태 버튼

- 현재 또는 가장 최근 `release-backend-prod.yaml` run 상태를 표시한다.
- downstream run이 아직 없고 승격 trigger가 실패·진행 중이면 그 trigger 상태와 URL을 대신 보여 준다.
- 누르면 현재 run을 열고, 실패 상태에서는 최초 실패 job URL을 연다.
- 이 버튼은 배포를 시작하거나 재실행하지 않는다.

## 5. 상태 표현

GitHub의 세부 상태는 아래의 제한된 공통 상태로 정규화한다.

| 공통 상태 | 표시 | 색상 | 입력 |
|---|---|---|---|
| `idle` | 대기 | 회색 | 역할에 따른 실행 또는 최근 run 열기 |
| `dispatching` | 요청 중 | 노랑 | 중복 실행 차단 |
| `queued` | 대기열 | 노랑 | run 열기 |
| `running` | 실행 중 | 파랑 | run 열기 |
| `approval-required` | 승인 대기 | 주황 | 승인 UI가 있는 run 열기 |
| `succeeded` | 완료 | 초록 | run 열기 |
| `no-change` | 변경 없음 | 회색 | RC 컷 run 열기 |
| `failed` | 실패 | 빨강 | 실패 job 또는 run 열기 |
| `cancelled` | 취소됨 | 빨강 | run 열기 |
| `unavailable` | 확인 불가 | 회색 | 저장된 마지막 URL이 있으면 열기 |

버튼의 고정 라벨은 `RC 컷`, `Stg 배포`, `Prod 승격`, `Prod 배포`다. 런타임 상태는 하단 detail과 상태 색으로 덮어쓴다. 태그를 알게 되면 detail에 잘린 태그와 상태를 함께 표시한다. 민감한 오류, 명령 출력 또는 토큰은 버튼에 표시하지 않는다.

## 6. 아키텍처

### 6.1 외부 seam

새 `GitHubActionsPipeline` 모듈은 Presentation과 Runtime에 다음 인터페이스만 제공한다.

```ts
type PipelineButtonRole = 'trigger' | 'deployment';
type PipelineGesture = 'press' | 'hold';

type PipelineButtonBinding = {
  pipelineId: string;
  role: PipelineButtonRole;
};

type PipelineButtonSnapshot = {
  binding: PipelineButtonBinding;
  state: PipelineState;
  detail: string;
  color: string;
  runUrl?: string;
};

interface GitHubActionsPipeline {
  snapshot(): readonly PipelineButtonSnapshot[];
  activate(binding: PipelineButtonBinding, gesture: PipelineGesture, signal: AbortSignal): Promise<void>;
  subscribe(listener: () => void): () => void;
  stop(): Promise<void>;
}
```

이 인터페이스 뒤에 dispatch, run 연결, tag·release 연결, pending deployment 판정, 실패 job 선택, 폴링, 재시도와 복구를 숨긴다. Presentation은 GitHub REST 응답이나 `gh` 출력 형식을 알지 않는다.

### 6.2 내부 모듈

- `GitHubCliAdapter`
  - 검증된 절대 경로의 `gh` 실행 파일을 literal argv로 호출한다.
  - `gh workflow run`, `gh api`, `gh run view`에 필요한 데이터만 JSON으로 받는다.
  - macOS Keychain의 기존 `gh` 인증을 사용한다.
  - 외부 명령은 timeout, 출력 상한, AbortSignal을 적용한다.
- `PipelineTracker`
  - 두 파이프라인의 트리거와 후속 run을 연결한다.
  - 원격 값을 공통 상태로 정규화하고 변경 시 subscriber를 깨운다.
- `PipelineStateStore`
  - 기존 SQLite `view_state`에 `github-actions/<pipelineId>` namespace로 제한된 JSON을 저장한다.
  - run ID, run URL, tag, workflow ID, 생성 시각, 마지막 공통 상태와 마지막 성공 조회 시각만 저장한다.
- `PipelineButtonBinding`
  - Studio 문서에는 `pipelineId`와 `role`만 저장한다.
  - 저장소, workflow 파일, `gh` 경로 또는 인증은 Studio 문서에 저장하지 않는다.

Production adapter와 결정론적 fake adapter가 같은 내부 seam을 사용한다. 외부 seam의 테스트는 caller와 같은 인터페이스를 통해 수행한다.

## 7. 구성과 Studio 문서

Runtime 설정에 비밀이 아닌 integration 정의를 추가한다.

```ts
type GitHubActionsConfig = {
  executable: string;
  pipelines: Array<{
    id: string;
    repository: string;
    ref: string;
    trigger: {
      workflow: string;
      inputs: Record<string, string>;
      gesture: 'press' | 'hold';
    };
    chain: {
      kind: 'tag-push' | 'release-published';
      anchorJob: string;
      anchorStep: string;
      tagPattern: string;
    };
    deployment: {
      workflow: string;
      event: 'push' | 'release';
      approvalEnvironment?: string;
    };
  }>;
};
```

초기 등록값은 다음과 같다.

- `crepe-backend-stg`
  - trigger: `cut-rc.yaml`, `develop`, `force-bump=auto`, `press`
  - chain: `tag-push`, `cut-rc`, `Push rc tag`, `backend/v*.*.*-rc.*`
  - deployment: `release-backend.yaml`, `push`, `stg-backend`
- `crepe-backend-prod`
  - trigger: `backend-release-cut-prod.yaml`, `develop`, 입력 없음, `hold`
  - chain: `release-published`, `cut-release`, `Create release`, `backend/v*.*.*`
  - deployment: `release-backend-prod.yaml`, `release`

설정 검증은 절대 실행 파일 경로, `owner/repo`, workflow 파일명, pipeline ID 중복, role 조합과 허용 gesture를 검사한다. workflow 입력은 설치된 신뢰 설정에서만 온다. Studio나 외부 신호는 임의 workflow 또는 입력을 추가하지 못한다.

Studio `ButtonAction`에는 다음 타입을 추가한다.

```ts
type GitHubPipelineAction = {
  type: 'github-pipeline';
  pipelineId: string;
  role: 'trigger' | 'deployment';
};
```

액션 라이브러리에는 `GitHub Actions` 항목을 추가한다. 속성 패널은 등록된 pipeline과 역할만 선택하게 한다. Crepe 네 버튼은 일반 Studio 문서로 저장되며, 하드코딩된 물리 키 번호는 Runtime 코드에 넣지 않는다.

제품 기본 문서나 새 사용자 설정에 private 저장소 버튼을 넣지 않는다. 구현 검증이 끝나면 현재 개발용 `.streamhub` 설정에 두 pipeline을 등록하고 기존 Studio 문서를 보존한 채 `crepe-release` 페이지와 네 버튼을 추가한다. 이 로컬 설정은 git에 커밋하지 않으며 실제 workflow dispatch 없이 렌더링·입력 의도까지만 검증한다.

## 8. 실행 연결

### 8.1 트리거 run

`gh workflow run`의 반환 URL을 우선 사용한다. URL이 반환되지 않으면 dispatch 시작 시각, workflow ID, event=`workflow_dispatch`, ref와 현재 사용자로 후보를 조회한다. 후보가 정확히 하나일 때만 채택한다. 여러 후보가 남으면 추측하지 않고 `확인 불가`로 표시하며 최근 workflow 페이지를 연다.

### 8.2 RC에서 Stg로 연결

1. `cut-rc.yaml`의 정확한 trigger run ID를 추적한다.
2. trigger run의 `cut-rc` job에서 `Push rc tag` step을 찾는다.
3. step conclusion이 `skipped`이면 `no-change`로 끝낸다.
4. step conclusion이 `success`이면 그 step 완료 시각 이후 생성되고 trigger run과 같은 `head_sha`를 가진 `release-backend.yaml`의 `push` run을 찾는다.
5. downstream run의 `head_branch`가 `backend/v*.*.*-rc.*` 형식일 때만 연결하고 그 값을 태그로 저장한다.
6. 90초 안에 유일한 downstream run을 찾지 못하면 `failed`가 아니라 `unavailable`로 표시한다. 트리거 성공과 배포 시작 실패를 임의로 같은 실패로 합치지 않는다.

### 8.3 Prod 승격에서 배포로 연결

1. `backend-release-cut-prod.yaml` trigger run을 추적한다.
2. dispatch 직전의 backend Release ID 집합을 저장한다.
3. `Create release` step이 성공하면 그 step 완료 시각 이후 published 되었고 baseline에 없으며 `backend/v*.*.*` 형식인 Release를 조회한다.
4. 후보 Release가 정확히 하나일 때 tag와 target commit을 저장한다.
5. 그 tag를 `head_branch`로 갖고 event=`release`이며 published 시각 이후 생성된 `release-backend-prod.yaml` run을 연결한다. 가능한 경우 Release target commit과 run `head_sha`도 같아야 한다.
6. 90초 안에 유일한 Release 또는 downstream run을 찾지 못하면 `unavailable`로 표시하고 승격 run URL을 유지한다.

모든 연결은 workflow database ID, event, SHA, 생성 시각과 태그 형식을 함께 확인한다. 단순히 "가장 최근 run" 하나만으로 버튼이 시작한 파이프라인을 연결하지 않는다.

## 9. 폴링과 복구

- dispatch 직후 run URL을 얻는 동안 5초 간격으로 최대 30초 조회한다.
- queued/running 상태는 10초 간격으로 조회한다.
- `approval-required`는 30초 간격으로 조회한다.
- 완료 상태와 외부에서 시작된 새 run 발견은 60초 간격으로 조회한다.
- 실패한 요청은 5초부터 60초까지 지수 backoff한다.
- 같은 pipeline의 폴링은 겹치지 않는다.
- HTTP 401/403은 즉시 `unavailable`로 전환하고 인증 원문을 노출하지 않는다.
- 네트워크 실패는 마지막 정상 상태와 URL을 보존하며 detail만 `확인 불가`로 바꾼다.
- Runtime 시작 시 저장 상태를 읽고 exact run ID를 먼저 재조회한다. 저장 run이 끝났으면 최신 관련 workflow run을 조회해 외부 실행도 발견한다.
- Runtime 종료는 진행 중 CLI 호출과 timer를 취소한 뒤 완료한다.

## 10. Presentation 통합

Presentation은 pipeline snapshot 변경 알림을 받으면 기존 전체 surface refresh 경로를 사용한다. 폴링 자체는 화면 잠금 중에도 계속하지만 잠금 화면을 깨우지 않는다. 잠금 해제 시 최신 snapshot으로 한 번 렌더링한다.

키 down 시 현재 generation, Studio button ID, pipeline binding과 gesture 후보를 캡처한다. key up 또는 hold 확정 시 현재 문서와 generation이 그대로일 때만 `activate`한다. 페이지 전환, 잠금, 문서 적용, Runtime 종료는 진행 중 activation을 취소한다.

기존 `PageBoard`의 로컬 `running/success/error` 상태는 일반 액션에 유지한다. GitHub pipeline 버튼은 외부 snapshot이 표시의 단일 진실이며 로컬 명령 종료만으로 성공을 표시하지 않는다.

## 11. 보안과 실패 처리

- `gh` 실행 경로는 설정 시 일반 실행 파일의 절대 경로로 정규화하고 Runtime 시작 때 다시 검증한다.
- 셸을 사용하지 않고 literal argv만 전달한다.
- stdout/stderr는 각각 1 MiB로 제한하고 UI에는 정규화된 오류만 전달한다.
- `gh auth token`을 호출하거나 출력하지 않는다.
- workflow·repo·입력은 신뢰 설정에서만 가져온다.
- URL은 `https://github.com/cookieplace/crepe/` 아래의 actions run, job, workflow 또는 release URL만 허용한다.
- open 동작은 기존 검증된 `/usr/bin/open` 경로를 재사용한다.
- Studio 브라우저에는 토큰, CLI 출력, raw REST 오류 또는 reviewer 목록을 보내지 않는다.
- Stream Deck에서 승인 API의 POST endpoint를 호출하지 않는다. read-only pending deployments 조회만 사용한다.

## 12. 테스트 전략

### 12.1 순수 상태 전이

- trigger와 downstream의 정상 연결
- RC tag step skipped → `no-change`
- queued → running → approval-required → running → succeeded
- 승인 거부, failure, timed_out, cancelled와 startup_failure 정규화
- 같은 SHA의 관련 없는 workflow와 잘못된 event 거부
- 둘 이상의 downstream 후보가 있으면 fail-closed
- 최초 실패 job URL 선택과 run URL fallback
- network/auth 오류에서 마지막 URL 보존

### 12.2 Adapter 계약

- literal argv, timeout, AbortSignal, 출력 상한
- `gh workflow run` URL 반환과 fallback discovery
- malformed JSON과 예상 밖 status 거부
- pending deployments에서 정확한 `stg-backend`만 승인 대기로 처리
- token과 raw stderr가 public error에 포함되지 않음

### 12.3 저장과 복구

- exact run ID 재조회
- active run에서 Runtime 재시작
- approval-required에서 Runtime 재시작
- 완료 뒤 외부에서 시작된 최신 run 발견
- 손상된 저장값 격리와 다른 view state 보존

### 12.4 Presentation과 Studio

- 네 버튼의 press/hold 의미
- Prod 승격이 press로 실행되지 않고 700ms hold에서 정확히 한 번 실행됨
- Stg 승인 대기 snapshot의 주황 상태와 run URL
- 실패 snapshot의 빨강 상태와 실패 job URL
- 페이지 전환·잠금·문서 변경 사이 stale key-up 차단
- Studio 문서 검증, 복사·붙여넣기와 저장 round trip
- 시뮬레이터는 GitHub를 호출하지 않고 상태와 실행 의도만 재현

### 12.5 통합 검증

fake GitHub adapter, 임시 SQLite와 fake deck backend를 사용해 다음 수직 흐름을 검증한다.

1. RC 컷 버튼 press
2. trigger run 연결
3. RC tag와 Stg run 연결
4. `stg-backend` 승인 대기 표시
5. 승인 후 두 deploy job 실행
6. 실패 job으로 버튼 URL 전환
7. Runtime 재시작 후 같은 run 복구

Prod 흐름도 hold → Release → Prod run → 성공/실패로 같은 검증을 수행한다. 실제 GitHub workflow dispatch는 자동 테스트에서 실행하지 않는다.

## 13. 완료 기준

- Studio에서 네 버튼을 일반 페이지에 배치하고 장치에 적용할 수 있다.
- RC 컷은 짧은 press, Prod 승격은 700ms hold에서만 실행된다.
- Stg 승인 대기가 `stg-backend` pending deployment로 정확히 표시된다.
- Stg·Prod 실패 버튼이 최초 실패 job을 연다.
- 외부에서 시작된 실행과 Runtime 재시작을 복구한다.
- 토큰이나 raw CLI/API 오류가 설정, DB, Studio 또는 로그에 노출되지 않는다.
- focused tests, `bun run check`, Stream Deck plugin check와 `git diff --check`가 통과한다.
