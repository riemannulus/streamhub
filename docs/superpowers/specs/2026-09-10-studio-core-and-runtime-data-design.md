# Streamhub Studio 기본 편집기와 Runtime 데이터 설계

- 날짜: 2026-09-10
- 상태: 대화에서 승인된 구조를 문서화한 구현 전 설계
- 선행 설계: `2026-09-10-streamdeck-plugin-only-architecture-design.md`
- 범위: Studio 기본 편집 기능, 버튼 표현, Runtime 데이터 소스, 동적 버튼, 구현 우선순위

## 1. 결정

Streamhub Studio는 동적 Claude/Codex 연동보다 먼저 일반적인 Stream Deck 편집기의 기본 사용 흐름을 완성한다. 사용자는 JSON, Bundle ID, 물리 Stream Deck App의 개별 셀 편집 없이 페이지를 만들고, 버튼을 배치하고, 아이콘과 라벨을 꾸미고, 페이지를 이동하고, 기본 시스템 동작을 실행할 수 있어야 한다.

Runtime이 수신한 데이터는 일반 버튼 동작과 섞지 않는다. Studio의 액션 라이브러리 안에 별도 `데이터` 그룹을 제공하고, 데이터에 따라 여러 키를 생성·갱신·제거하는 `동적 버튼 영역`을 배치한다. Claude Code와 Codex는 전용 화면 모델이 아니라 공통 데이터 소스 계약을 구현한다.

고정 버튼과 동적 버튼은 같은 표현 모델과 렌더러를 공유한다. 실행 동작, 표시 방식, 데이터 바인딩은 서로 독립적이다.

## 2. 제품 우선순위

다음 순서는 의존성과 사용자 가치를 함께 반영한 고정 순서다.

1. 페이지 생성과 페이지 이동
2. 기본 버튼 동작
3. 아이콘·라벨·투명 버튼 표현
4. 버튼 이동·복사 등 편집 작업성
5. 기본 편집 흐름의 실제 장치 승인
6. Runtime 데이터 소스와 동적 목록
7. 실제 Claude Code와 Codex adapter
8. 자동 실행·설치·복구 UX
9. 잠금·재연결 실기기 승인
10. 직접 HID 제거와 배포 패키징

Runtime adapter, 서비스 설치 또는 HID 제거가 1–5단계보다 먼저 진행되지 않는다. 화면을 구성할 수 없는 상태에서 백엔드 기능만 늘리지 않는다.

## 3. 첫 사용 가능 마일스톤

첫 마일스톤의 완료 조건은 다음 한 문장으로 고정한다.

> 빈 Studio에서 JSON이나 Bundle ID 입력 없이 3개 페이지를 만들고, 아이콘과 라벨을 가진 앱·웹·단축키 버튼과 이전·다음 버튼을 구성해 실제 장치에서 사용할 수 있다.

구체적인 승인 흐름은 다음과 같다.

1. `홈`, `웹`, `미디어` 페이지를 만들고 이름과 순서를 바꾼다.
2. Firefox를 앱 선택기로 고르고 아이콘과 `Firefox` 라벨을 함께 표시한다.
3. 웹사이트, 단축키, 텍스트, 미디어 버튼을 만든다.
4. 이전, 다음, 특정 페이지 이동, `1 / 3` 페이지 표시를 배치한다.
5. 버튼을 이동·복사하고 다른 페이지에 붙여 넣는다.
6. `장치에 적용` 후 실제 키에서 각 동작이 정확히 한 번 실행되는지 확인한다.

## 4. Studio 화면 구조

Studio는 네 영역으로 구성한다.

### 4.1 페이지 사이드바

- 페이지 추가
- 이름 변경
- 삭제
- 복제
- 드래그 순서 변경
- 기본 페이지 지정
- 대기 화면 선택
- 페이지별 더보기 메뉴

마지막 일반 페이지는 삭제할 수 없다. 삭제하려는 페이지를 가리키는 버튼이 있으면 참조 위치를 보여 주고 삭제를 막는다. 사용자는 참조 버튼을 제거하거나 다른 대상으로 바꾼 뒤 삭제한다.

### 4.2 액션 라이브러리

액션은 검색 가능하고 다음 그룹으로 나눈다.

```text
기본
  앱 열기
  파일·폴더
  웹사이트
  단축키
  텍스트
  미디어
  등록된 명령
  표시 전용

탐색
  특정 페이지로 이동
  이전 페이지
  다음 페이지
  페이지 표시
  자동 페이지 전환 복귀

데이터
  동적 버튼 영역
  동적 목록 이전
  동적 목록 다음
  긴급 항목으로 이동
```

액션을 빈 키로 끌어다 놓거나 빈 키를 선택한 뒤 액션을 클릭한다. 여러 키를 사용하는 `동적 버튼 영역`은 첫 키에 드롭한 뒤 캔버스에서 범위를 확장한다.

### 4.3 전체 화면 캔버스

- 실제 480×272 좌표와 15개 키 viewport를 사용한다.
- 전체 배경과 키 사이 숨겨진 간격을 유지한다.
- 선택, 드롭 대상, 동적 영역, 투명 버튼을 편집용 테두리로 구분한다.
- 편집용 테두리와 키 번호는 실제 장치 출력에 포함하지 않는다.
- 페이지 탐색과 데이터 목록 탐색을 서로 다른 배지로 표시한다.

### 4.4 속성 패널

속성 패널은 선택한 객체에 필요한 항목만 보여 준다.

- 고정 버튼: 동작, 표시 방식, 아이콘, 라벨, 버튼 배경
- 페이지 이동: 이동 방식, 대상 페이지, 표시
- 동적 영역: 데이터 소스, 키 범위, 필터, 정렬, 넘침, 템플릿, 누를 때 동작
- 페이지: 이름, 기본 페이지, 배경, 자동 전환 조건
- 대기 화면: 배경, 맞춤, 내보내기

## 5. 버튼 도메인

기존처럼 버튼 union 안에 실행과 표현을 섞지 않는다. 새 문서에서는 좌표, 실행 동작과 표현을 분리한다.

```ts
type ButtonDefinition = {
  id: string;
  index: number;
  action: ButtonAction;
  appearance: ButtonAppearance;
};

type ButtonAction =
  | {type: 'none'}
  | {type: 'open-app'; bundleId: string}
  | {type: 'open-path'; path: string}
  | {type: 'open-url'; url: string; browserBundleId?: string}
  | {type: 'hotkey'; keys: KeyCode[]}
  | {type: 'text'; text: string; mode: 'paste' | 'type'}
  | {type: 'media'; command: MediaCommand}
  | {type: 'registered'; name: string; args: Record<string, string>}
  | {type: 'go-to-page'; pageId: string}
  | {type: 'previous-page'}
  | {type: 'next-page'}
  | {type: 'page-indicator'}
  | {type: 'resume-auto-page'};

type MediaCommand =
  | 'play-pause'
  | 'previous-track'
  | 'next-track'
  | 'volume-up'
  | 'volume-down'
  | 'mute-toggle';
```

`KeyCode`는 Runtime에 고정된 macOS modifier·문자·기능 키 whitelist의 값이며 자유 문자열이 아니다. `page-indicator`와 `none`은 실행 효과가 없다. 단축키와 텍스트 입력은 현재 foreground 앱으로 전달되므로 Studio가 이 사실을 명시한다. 비밀번호 등 민감한 텍스트 저장 경고를 제공하고, 비밀 관리 기능으로 오해하게 하지 않는다.

앱은 설치된 애플리케이션 선택기로 고른다. 고급 사용자를 위해 Bundle ID를 읽기 전용 보조 정보로 보여 줄 수 있지만, 기본 입력값으로 요구하지 않는다. 파일과 폴더는 로컬 선택기로 고르고 절대 경로로 저장한다.

첫 마일스톤에서는 동시·순차 멀티 액션, 토글, 길게 누르기와 두 번 누르기를 제외한다. 단일 액션이 실기기에서 안정된 뒤 두 번째 기본 기능 묶음으로 추가한다.

## 6. 버튼 표현

모든 고정 버튼과 동적 버튼 템플릿은 다음 네 표시 방식을 지원한다.

```ts
type ButtonContentMode =
  | 'icon-and-label'
  | 'icon-only'
  | 'label-only'
  | 'hidden';
```

- `icon-and-label`: 아이콘과 라벨을 함께 합성한다.
- `icon-only`: 라벨 공간 없이 아이콘만 표시한다.
- `label-only`: 아이콘 없이 라벨만 표시한다.
- `hidden`: 아이콘과 라벨을 모두 숨겨 전체 배경만 보이게 한다. 동작은 유지된다.

```ts
type ButtonAppearance = {
  contentMode: ButtonContentMode;
  icon?: {assetId: string; fit: 'contain' | 'cover'};
  label?: {
    text: string;
    position: 'top' | 'center' | 'bottom';
    size: 'small' | 'medium' | 'large';
    color: string;
  };
  background?: {color?: string; assetId?: string; opacity: number};
};
```

현재 아이콘 자산이 렌더링된 키 전체를 교체해 라벨을 잃는 동작은 폐기한다. 렌더러는 배경 → 버튼 배경 → 아이콘 → 라벨 → 상태 배지 순서로 합성한다. Studio 미리보기와 Runtime은 같은 합성 함수를 사용한다.

`hidden` 버튼은 Studio에서 점선 테두리와 동작 아이콘으로 편집할 수 있지만 실제 장치에는 어떠한 편집 표시도 전송하지 않는다.

## 7. 페이지와 탐색

페이지와 동적 목록의 탐색은 별도 개념이다.

- `previous-page`, `next-page`, `go-to-page`: Studio 페이지를 이동한다.
- `page-indicator`: 현재 Studio 페이지 순서를 `1 / 3`으로 표시한다.
- `dynamic-previous`, `dynamic-next`: 한 동적 영역의 overflow 화면을 이동한다.
- `urgent-pin`: 동적 데이터 중 긴급 항목의 원래 위치로 이동한다.

페이지 이동은 수동 고정으로 간주한다. `resume-auto-page`를 누르기 전에는 앱 문맥 자동 전환이 수동 선택을 덮어쓰지 않는다.

페이지를 추가할 때 탐색 버튼을 강제로 만들지 않는다. 대신 `탐색 버튼 자동 추가`를 기본 선택으로 제공하고, 사용자가 위치를 고른다. 새 페이지로 인해 기존 페이지의 빈 키가 부족하면 자동 삽입하지 않고 위치 선택을 요청한다.

## 8. Runtime 데이터 소스

외부 도구별 payload를 Studio가 직접 이해하지 않는다. 신뢰하는 adapter가 Runtime 공통 레코드와 소스 정의로 변환한다.

```ts
type SourceDefinition = {
  id: string;
  name: string;
  recordKind: 'live' | 'event' | 'gauge';
  fields: SourceField[];
  actions: SourceAction[];
};

type SourceAction = {
  id: string;
  label: string;
  args: Record<string, {
    type: 'string' | 'number' | 'boolean';
    recordFields: string[];
  }>;
};

type SourceField = {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'timestamp' | 'enum';
  values?: string[];
  filterable: boolean;
  displayable: boolean;
};

type RuntimeRecord = {
  source: string;
  id: string;
  kind: 'live' | 'event' | 'gauge';
  label: string;
  detail?: string;
  level: 'info' | 'warn' | 'urgent';
  freshness: 'fresh' | 'stale';
  attributes: Record<string, string | number | boolean>;
  createdAt: number;
  updatedAt: number;
};
```

소스 정의는 설치된 신뢰 adapter가 등록한다. 외부 payload는 필드 정의, 실행 파일, action 이름, 정규식 또는 템플릿을 추가하거나 변경할 수 없다. 알 수 없는 속성, 잘못된 타입과 허용되지 않은 enum 값은 해당 명령 전체를 거부한다.

현재 `LiveSignal.press`처럼 신호 payload가 실행 동작을 지정하는 경로는 새 Studio 문서에서 사용하지 않고 제거 대상으로 표시한다. 실행은 Studio가 등록된 `SourceAction`을 선택하고 Runtime이 현재 레코드 값을 검증해 인자로 결합한다.

## 9. 데이터 기능의 Studio 표현

Studio에는 캔버스의 `데이터` 액션 그룹과 별도 `데이터 소스` 관리 화면이 있다.

데이터 소스 화면은 다음만 보여 준다.

- 표시 이름과 adapter 종류
- 정상, 지연, 오류, 중단 상태
- 현재 레코드 수
- 마지막 성공 시각
- 최근 레코드 샘플
- 사용 중인 페이지와 영역
- adapter 다시 시작
- 샘플 데이터 미리보기

원본 토큰, 전체 환경변수, 명령 stdout과 민감한 인자는 브라우저로 보내지 않는다.

첫 데이터 블록은 `동적 버튼 영역`이다.

```ts
type DynamicRegionDefinition = {
  id: string;
  keys: number[];
  sourceId: string;
  filter: FilterExpression;
  order: 'recent' | 'urgent-first' | 'label';
  overflow: 'paginate' | 'replace-oldest';
  empty: 'background' | 'placeholder';
  template: DynamicButtonTemplate;
  onPress?: DynamicActionBinding;
};

type FilterExpression = {
  all: Array<{
    field: string;
    operator: 'equals' | 'not-equals' | 'one-of';
    value: string | number | boolean | Array<string | number | boolean>;
  }>;
};

type DynamicActionBinding = {
  actionId: string;
  args: Record<string, {recordField: string}>;
};
```

Studio는 실제 Runtime 데이터와 별개로 스키마에 맞는 로컬 샘플 레코드를 만들 수 있다. 샘플은 미리보기에만 존재하고 Runtime 저장소나 실제 장치 액션에 게시되지 않는다.

## 10. 동적 버튼 수명과 안정성

- `(source, id)`가 같은 레코드는 갱신돼도 가능한 한 같은 키를 유지한다.
- 가운데 항목이 사라져도 기존 버튼을 당겨서 재배치하지 않는다. 새 항목이 빈 슬롯을 사용한다.
- 성공한 remove 또는 membership의 연속 두 번 누락 후 버튼을 제거한다.
- 소스 수집 실패는 기존 버튼을 제거하지 않고 stale 표현으로 바꾼다.
- Runtime 재시작 후 저장된 레코드는 stale로 시작하고 adapter가 확인하면 갱신한다.
- 영역보다 항목이 많으면 영역 단위 페이지를 만든다.
- 동적 영역의 페이지 전환은 Studio 페이지를 바꾸지 않는다.
- 데이터 변경, 화면 전환 또는 reconnect로 binding이 바뀌면 진행 중인 press를 취소한다.

## 11. 동적 버튼 표현과 동작

동적 템플릿은 고정 버튼과 같은 네 표시 방식을 사용하고, 레코드 필드를 표시 값에 연결한다.

```ts
type DynamicButtonTemplate = {
  appearance: ButtonAppearance;
  labelField?: string;
  detailField?: string;
  rules: AppearanceRule[];
};

type AppearanceRule = {
  field: string;
  equals: string | number | boolean;
  iconAssetId?: string;
  color?: string;
  opacity?: number;
};
```

예를 들어 Claude adapter는 `state = working | waiting | done | failed`를 선언하고 Studio는 각 상태에 아이콘과 색을 연결한다. Codex도 같은 템플릿을 사용한다.

누를 때 동작은 소스가 허용한 action만 선택한다. `focus-session`은 `sessionId` 인자에 `record.id`를 연결한다. Runtime은 key-up 시 source 권한, 현재 record 존재, revision, presentation generation, argument schema와 대상 소유권을 다시 검증한다. 조건이 하나라도 달라지면 실행하지 않는다.

## 12. 데이터 종류별 범위

### 첫 구현: live

Claude Code 세션, Codex 작업, 로컬 실행 작업처럼 생성부터 종료까지 존재하는 항목을 동적 목록에 배치한다.

### 후속: event

확인 가능한 알림을 표시하고 TTL과 명시적 확인을 제공한다. 버튼 실행 성공을 자동 확인으로 간주하지 않는다.

### 후속: gauge

빌드 큐 길이, CPU 또는 연결 수 같은 단일 값을 예약된 키에 표시한다. 값이 없으면 `데이터 없음`, source 장애면 마지막 값과 stale 표시를 함께 보여 준다.

event와 gauge의 구현은 첫 기본 편집기와 live 동적 목록을 지연시키지 않는다.

## 13. 실제 Claude Code와 Codex 연결

제품별 adapter는 다음 두 기능만 구현한다.

```ts
interface SessionAdapter {
  definition(): SourceDefinition;
  list(signal?: AbortSignal): Promise<RuntimeRecord[]>;
  invoke(actionId: string, recordId: string, signal?: AbortSignal): Promise<void>;
}
```

- `list`: 현재 adapter가 책임지는 완전한 세션 목록을 반환한다.
- `invoke`: adapter가 등록한 action을 현재 세션에 수행한다.

프로세스 제목, 창 제목 또는 화면 텍스트에서 세션 ID를 추측하지 않는다. 제품이 제공하는 공식 또는 검증 가능한 로컬 인터페이스가 없으면 adapter를 지원된 것으로 표시하지 않는다.

Claude Code와 Codex 화면은 preset으로 제공할 수 있지만 preset은 일반 `DynamicRegionDefinition`으로 펼쳐진다. 이후 사용자가 필터, 키 범위, 표현과 동작을 수정할 수 있다.

## 14. 오류 처리

- Runtime offline: 마지막 Studio 문서를 편집할 수 있지만 live 데이터는 `연결 안 됨`으로 표시한다.
- Source offline: 기존 버튼을 stale로 유지하고 원인을 데이터 소스 화면에 표시한다.
- Unknown source: 문서 적용을 거부하고 참조 페이지와 영역을 알려 준다.
- Invalid field mapping: 저장 전에 필드 이름과 예상 타입을 표시한다.
- Missing action: 동적 버튼은 표시하되 입력을 비활성화하고 속성 패널에 해결 동작을 제공한다.
- Partial region: 영역의 모든 키와 탐색 키가 유효하기 전까지 적용을 막는다.
- Asset failure: 이전 완전한 generation을 유지한다.
- Action uncertainty: 외부 실행 결과가 불명확하면 자동 재실행하지 않는다.

## 15. 문서 버전과 초기화

버튼 도메인이 실행과 표현을 분리하므로 새 Studio 문서는 version 3으로 시작한다. 이 프로젝트는 아직 출시 전이고 사용자가 초기화를 승인했으므로 v2 자동 migration은 만들지 않는다.

- 기존 v2 문서 파일은 덮어쓰지 않고 날짜가 붙은 backup으로 이동한다.
- 콘텐츠 해시 이미지 자산은 삭제하지 않는다.
- v3 기본 문서는 한 개의 빈 `홈` 페이지와 검은 standby 배경으로 시작한다. 기존 자산은 Studio 자산 선택기에서 다시 고를 수 있다.
- Studio는 backup 위치와 새 문서 시작 사실을 한 번 안내한다.

## 16. 구현 순서와 단계별 완료 기준

### 단계 1 — StudioDocument v3와 공용 버튼 합성

- 실행 동작과 표현 분리
- 네 표시 방식
- 아이콘과 라벨 동시 합성
- Studio와 Runtime 공용 렌더 입력

완료 기준: 네 표시 방식의 Studio 미리보기와 Runtime PNG 픽셀 해시가 일치한다.

### 단계 2 — 페이지 관리와 탐색

- 추가, 이름 변경, 삭제, 복제, 정렬, 기본 페이지
- 이전, 다음, 특정 페이지 이동, 페이지 표시, 자동 복귀
- 참조 무결성

완료 기준: Studio만으로 3페이지를 만들고 공용 시뮬레이터에서 모든 탐색 버튼의 목적지와 `1 / 3` 표시가 정확하다.

### 단계 3 — 기본 액션 라이브러리

- 앱, 파일·폴더, 웹, 단축키, 텍스트, 미디어, 등록 명령, 표시 전용
- 앱·파일 선택기
- action별 속성 패널과 검증

완료 기준: Bundle ID나 JSON을 입력하지 않고 각 단일 action을 만들며 host 통합 테스트에서 각 effect가 한 번만 실행된다.

### 단계 4 — 편집 작업성

- 드래그 배치와 이동
- 복사, 붙여넣기, 복제, 삭제
- 페이지 간 복사
- undo/redo와 dirty/applied 상태

완료 기준: 홈·웹·미디어 예제 프로필을 빈 문서에서 10분 안에 구성한다.

### 단계 5 — 기본 기능 실기기 승인

- 3페이지 구성
- 아이콘·라벨과 전체 배경 확인
- 모든 기본 action과 페이지 탐색
- Studio 닫은 뒤 Runtime·플러그인 지속 동작

완료 기준: 첫 사용 가능 마일스톤의 여섯 단계가 모두 통과한다.

### 단계 6 — 기본 기능 2차

- 순차·동시 multi action
- delay
- toggle
- press, double press, hold key logic

완료 기준: 단일 action 안전 계약을 재사용하고 중첩 multi action 없이 각 입력 방식이 한 번만 실행된다.

### 단계 7 — Runtime Source Registry와 데이터 화면

- SourceDefinition 등록과 검증
- RuntimeRecord attributes
- source health와 sample API
- Studio 데이터 소스 화면

완료 기준: demo source의 스키마, 상태와 샘플 레코드를 Studio에서 확인한다.

### 단계 8 — live 동적 버튼 영역

- 영역 선택
- filter, order, overflow, empty
- 공용 버튼 템플릿과 표현 규칙
- 동적 목록 탐색과 safe press binding

완료 기준: 0개, 1개, 영역 용량, 영역 초과 레코드가 안정적인 슬롯과 정확한 탐색을 사용한다.

### 단계 9 — Claude Code와 Codex adapter

- 검증 가능한 세션 목록
- focus/open action
- preset
- 실제 생성·갱신·종료

완료 기준: 실제 세션이 버튼으로 생기고 같은 위치에서 갱신되며, 누르면 정확한 세션을 한 번 열고 종료 후 배경을 복구한다.

### 단계 10 — 운영과 설치

- 로그인 시 Runtime 자동 실행
- plugin/profile/15-cell 상태 검사
- standby export와 안내
- 구체적인 연결 오류와 복구 동작

완료 기준: 재부팅 후 터미널 명령 없이 Streamhub 화면과 동작이 복구된다.

### 단계 11 — 플러그인 실기기 최종 승인

- 잠금·해제 10회 계측
- Runtime, Stream Deck App과 plugin 재시작
- USB 분리·연결
- 전환 중 데이터 갱신과 press 취소

완료 기준: plugin-only 설계의 성능표와 오류 처리 기준을 모두 만족한다.

### 단계 12 — 직접 HID 제거와 배포

- direct HID 코드, 의존성, 진단 스크립트와 문서 제거
- plugin-only 설치 패키지
- 24시간 daily-driver soak

완료 기준: 저장소와 배포물에 장치를 직접 여는 코드가 없고 cold start, 기본 편집, 동적 세션과 복구 시나리오가 통과한다.

## 17. 비목표

- 첫 마일스톤의 multi action과 Key Logic
- 첫 데이터 단계의 event와 gauge
- 임의 JSON/JQ를 Studio에서 작성하는 데이터 mapper
- 외부 record가 실행 파일이나 action 이름을 지정하는 기능
- Stream Deck Marketplace plugin 전체를 Studio 안에서 재현
- 다중 Stream Deck과 Stream Deck + dial
- Windows 지원
- 원격 Runtime 접근
- 비디오 또는 임의 HTML 키 렌더링

## 18. 출시 승인 기준

- 기본 페이지와 버튼을 Studio UI만으로 구성한다.
- 아이콘과 라벨을 함께 또는 각각 표시하고 완전히 숨길 수 있다.
- 페이지 탐색과 동적 목록 탐색이 구분된다.
- Studio 미리보기와 실제 장치의 배경 crop, 아이콘, 라벨이 일치한다.
- Runtime 데이터는 등록된 스키마만 사용하고 외부 payload가 실행 권한을 정하지 않는다.
- 같은 동적 레코드는 가능한 한 같은 키를 유지한다.
- stale input, 전환 중 input과 사라진 record의 action을 실행하지 않는다.
- Claude Code와 Codex는 공통 source/record/region 모델로 동작한다.
- 로그인, 잠금, 재시작과 USB 재연결에서 최신 완전한 화면으로 복구한다.
- Stream Deck App만 물리 장치를 소유한다.
- 직접 HID 의존성과 운영 경로가 제거된다.
