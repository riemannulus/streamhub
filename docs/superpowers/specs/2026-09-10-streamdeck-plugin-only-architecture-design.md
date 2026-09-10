# Streamhub Stream Deck 플러그인 전용 아키텍처 설계

- 날짜: 2026-09-10
- 상태: 승인된 방향을 문서화한 구현 전 설계
- 범위: 장치 소유권, Runtime/플러그인/Studio 경계, 화면 렌더링, 잠금 해제 애니메이션, HID 제거
- 선행 검증: `poc/streamdeck-crossfade`
- 대체 대상: 기존 Studio 설계의 설정 호환, 직접 HID 출력, 장치 수명주기와 대기화면 결정

## 1. 결정

Streamhub는 Elgato Stream Deck App을 통해서만 물리 Stream Deck을 제어한다. 제품 런타임은 USB/HID 장치를 직접 열지 않는다.

Stream Deck App의 전용 프로필에는 5×3 모든 위치에 동일한 `Streamhub Canvas Cell` 액션을 배치한다. 각 셀은 독립적으로 설정되는 버튼이 아니라, Streamhub가 생성한 한 장의 전체 화면을 표시하고 하나의 좌표 입력을 전달하는 표면이다.

버튼, 페이지, 배경, 아이콘, 동적 할당, 대기화면과 애니메이션 설정은 모두 Studio가 관리한다. Stream Deck App은 장치·프로필·플러그인 실행을 소유하지만 Streamhub 버튼 구성의 원본은 아니다.

직접 HID 구현은 플러그인 경로가 승인 기준을 통과할 때까지 비교와 복구 목적으로 저장소에 남겨 둔다. 이후 제품 경로와 의존성, 진단 도구를 함께 제거한다. 직접 HID와 플러그인을 동시에 지원하는 이중 제품 모드는 만들지 않는다.

## 2. 결정 배경

직접 HID 방식은 잠금 해제 후 약 0.5초 안에 화면을 복원할 수 있지만 다음 책임을 Streamhub가 직접 떠안는다.

- USB/HID 장치 탐색과 단독 소유
- 모델별 화면 크기, 픽셀 형식과 키 매핑
- 연결 해제, 재연결, 잠자기와 종료 정리
- Stream Deck App과의 장치 소유권 충돌
- 장치·펌웨어 호환성과 진단 도구
- 사용자가 기대하는 프로필 설치와 장치 관리 경험

플러그인 방식은 Elgato 앱의 세션 복귀 정책 때문에 잠금 해제 시 추가 지연이 있다. 실기기 로그에서는 `warming up`부터 `resume`까지 약 3초가 반복되었고, `resume`부터 장치 연결까지는 약 120–140ms였다. PoC의 7단계·15키 크로스페이드는 약 270–278ms였다. 따라서 잠금 해제 지연의 주원인은 Streamhub 렌더링이 아니라 Stream Deck App의 장치 재개 gate다.

이 외부 지연을 제거하려 하지 않고, 장치가 다시 사용 가능해진 순간 대기화면에서 최신 작업 화면으로 의도적인 복귀 애니메이션을 재생한다.

## 3. 목표

1. Stream Deck App이 물리 장치의 유일한 소유자가 된다.
2. 15개의 키가 하나의 480×272 LCD 화면처럼 자연스럽게 보인다.
3. 페이지 전환과 잠금 해제에 전체 화면 애니메이션을 적용한다.
4. Claude 세션 생성 같은 데이터 변화가 버튼 생성·갱신·제거로 자동 반영된다.
5. Studio에서 정적 버튼과 동적 슬롯을 같은 캔버스 위에서 관리한다.
6. Runtime 재시작, 플러그인 재시작, USB 재연결 뒤 안전하게 복구한다.
7. 전환 중이거나 표시 상태가 불확실할 때 버튼 액션을 실행하지 않는다.
8. 플러그인 경로 승인 뒤 직접 HID 코드와 의존성을 완전히 제거한다.

## 4. 비목표

- Stream Deck App을 대체하는 범용 장치 관리 앱
- Stream Deck App의 사용자 정의 프로필을 임의로 읽거나 수정
- 여러 제조사의 HID 매크로 패드 지원
- 최초 릴리스에서 모든 장치 크기 지원
- 비디오, 웹 페이지 또는 임의 HTML을 키에서 재생
- 잠금 해제 전에 Elgato 앱의 warm-up을 우회
- HID와 플러그인을 런타임에서 선택하는 호환 모드

첫 제품 범위는 현재 검증한 5×3, 72×72 키의 Stream Deck Classic/MK.2 계열 한 대다.

## 5. 모듈 경계

```text
Collectors ───────────────┐
                         ▼
Studio ──commands──▶ Streamhub Runtime ──presentation──▶ Stream Deck Plugin
                         ▲                                  │
                         └──────── key events ──────────────┘
```

### 5.1 Studio

Studio는 다음 설정을 편집한다.

- 페이지와 페이지 배경
- 고정 버튼, 아이콘, 투명도와 액션
- 동적 슬롯과 데이터 배치 규칙
- 대기화면
- 페이지 전환, 잠금 해제, 재연결 애니메이션

브라우저는 문서 원본을 소유하지 않는다. 서버 측 `StudioSession`이 초안, 실행 취소 이력, 적용 버전과 자산 참조를 소유한다. `장치에 적용`은 문서를 Runtime에 게시하는 명령이다.

Studio는 HID와 Stream Deck SDK를 import하지 않는다.

### 5.2 Streamhub Runtime

Runtime이 제품 상태의 유일한 원본이다.

- 수집기 실행과 신호 저장
- 앱 문맥과 사용자 세션 상태 감지
- 현재 페이지 선택
- 고정 버튼과 동적 버튼의 좌표 할당
- 버튼 ID와 실제 액션의 결합
- 전체 LCD 캔버스 렌더링
- 애니메이션 프레임 컴파일
- 키 down/up 검증과 액션 실행
- 플러그인 연결 상태와 표시 세대 관리

Runtime은 물리 장치 API를 알지 않는다. 외부에는 `PresentationGateway`라는 작은 인터페이스만 노출한다.

```ts
interface PresentationGateway {
  publish(presentation: CompiledPresentation): Promise<PublishReceipt>;
  status(): PresentationStatus;
}
```

### 5.3 Stream Deck 플러그인

플러그인은 얇은 장치 adapter다.

- Stream Deck SDK 연결
- 장치와 15개 액션 인스턴스 추적
- 좌표별 이미지 적용
- 시간 기준 애니메이션 재생
- 키 down/up을 Runtime으로 전달
- 복귀 패키지 캐시
- 연결 불가 화면 표시

플러그인은 데이터 수집, 페이지 선택, 버튼 할당 또는 임의 명령 실행을 하지 않는다. Firefox 실행 같은 외부 효과도 Runtime이 검증하고 실행한다.

### 5.4 Stream Deck App

Stream Deck App은 다음만 소유한다.

- 물리 장치와 펌웨어
- 플러그인 프로세스 실행
- 전용 Streamhub 프로필
- 15개 Canvas Cell 액션 배치

Property Inspector에는 Runtime 연결 상태, 15개 셀 배치 상태, `Studio 열기`, `다시 연결`만 표시한다. 개별 버튼 편집기는 제공하지 않는다.

## 6. 전체 화면 좌표계

논리 화면은 gapless 360×216 이미지가 아니라 실제 Stream Deck Classic LCD의 480×272 좌표계를 사용한다.

- 전체 LCD: 480×272
- 키: 72×72
- 열 시작점: 11, 108, 205, 302, 399
- 행 시작점: 5, 102, 199
- 키 pitch: 97
- 키 사이 숨겨진 간격: 25

Studio 미리보기, Runtime 렌더러와 플러그인용 키 분할은 같은 `DeviceGeometry`를 사용한다. 배경은 전체 LCD 좌표계에서 `cover`, `contain`, `stretch` 중 하나로 배치한 다음 키 viewport를 추출한다.

## 7. 새 설정 문서

기존 `streamdeck.board`와 저장된 Stream Deck 레이아웃은 읽거나 마이그레이션하지 않는다. 새 문서는 별도 버전으로 시작한다.

```ts
type StudioDocument = {
  version: 2;
  device: { kind: 'streamdeck-classic-5x3' };
  pages: PageDefinition[];
  defaultPageId: string;
  standby: StandbyDefinition;
  motion: {
    pageChange: TransitionSpec;
    unlock: TransitionSpec;
    reconnect: TransitionSpec;
  };
};

type TransitionSpec = {
  type: 'none' | 'crossfade' | 'fade-through-black';
  durationMs: number;
};
```

자산은 콘텐츠 해시로 저장하고 문서는 해시 ID만 참조한다. 인증 토큰, sources, collectors, actions와 신호 DB는 화면 설정이 아니므로 유지한다.

## 8. 동적 버튼 할당

정적 버튼은 고정 좌표를 차지한다. 동적 데이터는 Studio에서 지정한 `DynamicRegion` 안에서만 버튼을 만든다.

```ts
type DynamicRegion = {
  id: string;
  keys: number[];
  filter: SignalFilter;
  order: 'recent' | 'urgent-first';
  overflow: 'paginate' | 'replace-oldest';
  empty: 'background' | 'placeholder';
  onPress?: DynamicActionBinding;
};

type DynamicActionBinding = {
  action: string;
  args: Record<string, { recordField: string }>;
};
```

Claude 세션 생성 시 Runtime은 새 record를 해당 region에 할당한다. 화면 revision이 바뀌어도 같은 세션은 가능한 한 같은 키를 유지한다. 세션이 종료되거나 보존 시간이 지나면 버튼을 제거하고 배경을 복원한다.

동적 record가 실행 파일이나 명령을 제공하지는 못한다. Studio가 신뢰 설정에 등록된 action을 선택하고, Runtime은 허용한 record 필드만 action 인자로 변환한다. 예를 들어 Claude region은 `focus-claude-session` action의 `sessionId` 인자에 record의 세션 ID를 결합한다. 기존 source/action 허용 규칙을 통과하지 못하면 문서 적용 자체를 거부한다.

키 down 시 Runtime은 `{deviceId, cell, presentationRevision, pressId}`와 현재 `bindingId`를 보존한다. key up 시 같은 화면 세대와 같은 binding일 때만 액션을 실행한다. 그 사이 페이지나 할당이 바뀌면 입력을 취소한다.

## 9. 렌더링과 애니메이션

### 9.1 렌더링 파이프라인

```text
StudioDocument + RuntimeState
  → PresentationModel
  → DeckCanvas(480×272 RGBA)
  → TransitionCompiler
  → 15-key PNG frame sets
  → Plugin Playback
```

`DeckVisualRenderer`는 최종 캔버스를 만든다. `TransitionCompiler`는 시작과 목표 캔버스를 받아 불투명한 프레임 묶음을 만든다.

```ts
interface TransitionCompiler {
  compile(
    from: DeckCanvas,
    to: DeckCanvas,
    spec: TransitionSpec,
  ): Promise<CompiledTransition>;
}
```

플러그인은 효과 이름이나 합성 규칙을 알지 않는다. 프레임과 deadline만 재생하므로 새 효과는 Runtime에만 추가한다.

### 9.2 첫 지원 효과

- `crossfade`: 일반 페이지 전환 기본값, 280ms
- `fade-through-black`: 잠금 해제 기본값, 480ms
- `none`: 즉시 적용

wipe, zoom, glitch는 인터페이스를 바꾸지 않고 나중에 추가할 수 있다. 첫 릴리스에서는 15개 키의 갱신이 원자적이지 않아도 시각적 편차가 작은 효과만 기본 제공한다.

### 9.3 재생 규칙

- 같은 프레임의 15개 `setImage` 요청은 동시에 시작한다.
- cadence는 이전 프레임 완료 후 sleep이 아니라 시작 시각의 절대 deadline으로 계산한다.
- deadline을 지난 중간 프레임은 건너뛴다.
- 마지막 목표 프레임은 반드시 요청한다.
- 더 최신 presentation이 도착하면 진행 중인 전환을 취소한다.
- 전환 시작부터 최종 프레임 요청 완료까지 입력을 차단한다.
- SDK Promise는 하드웨어 표시 완료가 아니라 요청 전송 완료이므로 상태 이름은 `displayed`가 아니라 `sent`를 사용한다.

## 10. 잠금 해제 복귀

Elgato warm-up 중에는 플러그인이 장치에 쓸 수 없다. 추가 지연을 막기 위해 복귀 프레임은 장치가 사라진 동안 미리 준비한다.

1. macOS 잠금 상태가 되면 Runtime은 액션을 취소하고 standby presentation을 만든다.
2. 플러그인은 가능한 동안 standby를 적용한다. Stream Deck App이 먼저 장치를 중단하면 적용은 best effort다.
3. Runtime은 잠금 중에도 collectors를 실행하고 최신 작업 화면을 계산한다.
4. 최신 `standby → live` 전환을 컴파일해 플러그인에 미리 전달한다.
5. 플러그인은 복귀 패키지를 메모리와 디스크에 원자적으로 캐시한다.
6. 잠금 해제 후 15개 `willAppear`가 모두 도착하거나 짧은 barrier timeout이 끝나면 복귀 애니메이션을 시작한다.
7. 마지막 프레임 요청 후 Runtime에 `presentation-sent`를 보내고 입력을 활성화한다.

Runtime이 잠시 연결되지 않아도 플러그인은 캐시된 복귀 패키지를 재생한다. 캐시도 없으면 번들에 포함된 연결 대기 화면을 표시한다.

프로필 전환, Studio 편집 또는 Stream Deck App UI 때문에 액션이 다시 나타난 경우에는 unlock 효과를 사용하지 않는다. Runtime 세션 상태, 이전 플러그인 상태와 이벤트 시간을 조합해 `unlock`, `reconnect`, `profile-return`을 구분한다.

### 10.1 네이티브 스크린세이버 경계

Stream Deck SDK는 장치 전체 네이티브 스크린세이버를 설정하는 공개 명령을 제공하지 않는다. Studio의 standby 자산은 다음에는 자동 적용할 수 있다.

- 세션 활성 중 Streamhub 유휴 화면
- Runtime offline 화면
- 잠금 직전의 best-effort standby 전환
- unlock 애니메이션의 첫 프레임

macOS 잠금과 동시에 Stream Deck App이 장치를 먼저 중단하면 플러그인의 마지막 standby 요청은 전달되지 않을 수 있다. 잠금 중 표시되는 이미지와 unlock 애니메이션의 시작 이미지를 확실히 일치시키려면, Studio가 생성한 480×272 standby 이미지를 사용자가 Stream Deck App의 네이티브 스크린세이버로 한 번 설정해야 한다. Studio는 파일 내보내기와 설정 안내를 제공하지만 자동 설정 성공을 표시하지 않는다.

unlock 시 플러그인은 네이티브 스크린세이버가 맞게 설정되었다고 가정하지 않는다. 먼저 standby 최종 프레임을 15개 셀에 동기화한 뒤 복귀 애니메이션을 시작한다. 이 동기화 단계는 성능 측정에 포함한다.

## 11. 상태 머신

```text
ACTIVE
  ├─ session locked ─────▶ STANDBY
  ├─ actions disappeared ▶ UNAVAILABLE
  └─ runtime lost ───────▶ OFFLINE

STANDBY / UNAVAILABLE
  └─ session active + cells ready ▶ RESTORING ▶ ACTIVE

OFFLINE
  ├─ runtime reconnected ▶ RESTORING ▶ ACTIVE
  └─ timeout ────────────▶ OFFLINE SCREEN
```

`RESTORING` 동안 키 이벤트는 기록하지 않고 버린다. 장치에서 이미 눌린 키가 있으면 모든 키가 놓인 뒤에만 입력을 다시 허용한다.

## 12. Runtime–플러그인 프로토콜

기존 loopback 서버에 인증 WebSocket endpoint를 추가한다. 플러그인은 서버로 outbound 연결한다.

주요 메시지는 다음과 같다.

- `hello`: protocol/plugin version, device ID, 크기, 활성 셀 좌표
- `device-state`: appeared, disappeared, cells-ready
- `presentation`: generation, revision, trigger, frame manifest와 이미지
- `presentation-sent`: generation, 최종 프레임 요청 결과와 측정 시간
- `key`: device ID, cell, edge, press ID, presentation revision
- `error`: 지원하지 않는 장치, 빠진 셀, 이미지 전송 실패
- `heartbeat`: 연결 생존과 latency

모든 메시지는 versioned schema로 검증한다. 알 수 없는 필드는 거부한다. presentation에는 제한된 총 바이트 수, 프레임 수와 duration 범위를 적용한다.

전환 이미지는 WebSocket으로 전달하고 플러그인이 사용자별 캐시 디렉터리에 원자적으로 저장한다. `setImage`에는 플러그인 외부 파일 경로를 넘기지 않고 검증한 PNG를 data URI로 변환해 전달한다. 마지막으로 검증된 두 generation만 디스크에 유지한다.

설치 도구는 `~/Library/Application Support/Streamhub/plugin/`에 권한 `0700` 디렉터리와 `0600` 연결 토큰을 만든다. Runtime과 플러그인이 같은 토큰을 읽는다. 토큰을 Stream Deck action 설정이나 Studio 문서에 저장하지 않는다.

첫 범위에서는 한 Runtime에 한 장치만 활성화한다. 둘 이상의 지원 장치가 연결되면 자동으로 임의 장치를 선택하지 않고 Studio에 선택 요구 상태를 표시한다.

## 13. 프로필과 온보딩

플러그인은 사용자 프로필을 임의로 수정하지 않는다. 배포물에 15개 Canvas Cell 액션이 미리 배치된 Streamhub 전용 프로필을 포함한다.

온보딩은 다음 상태를 검사한다.

- 플러그인 설치됨
- 지원 장치 연결됨
- Streamhub 프로필 설치됨
- 15개 셀이 모두 존재하고 좌표가 고유함
- Runtime 연결됨
- Stream Deck App 자체 스크린세이버 충돌 여부

조건이 충족되지 않으면 Studio에서 한 문장 설명과 수정 동작을 제공한다. Streamhub standby를 네이티브 잠금 화면과 일치시키려는 경우에는 Studio가 내보낸 이미지를 Stream Deck App 스크린세이버로 설정하도록 안내한다. 네이티브 스크린세이버를 사용하지 않으려는 경우에는 끄거나 충분히 긴 시간으로 설정하도록 안내한다.

## 14. 성능 기준

Elgato App의 `warming up` 시간은 외부 지연으로 따로 기록한다. Streamhub 승인 기준은 장치가 플러그인에 사용 가능해진 뒤부터 측정한다.

| 구간 | 목표 |
|---|---:|
| cells-ready → 첫 복귀 프레임 요청 | 150ms 이하 |
| cells-ready → 복귀 최종 프레임 요청 | 700ms 이하 |
| 일반 페이지 전환 | 350ms 이하 |
| 기본 unlock 애니메이션 | 480ms |
| stale 중간 프레임 backlog | 0 |
| 정상 전환 중 잘못 실행된 키 액션 | 0 |

실기기 잠금·해제를 10회 반복해 p50, p95, 최댓값을 기록한다. 사용자가 보는 전체 복귀 시간도 별도로 기록하되 Streamhub 구간과 Elgato warm-up을 혼합하지 않는다.

## 15. 오류 처리

- **Runtime 시작 전:** 플러그인 번들의 연결 대기 화면과 입력 차단
- **Runtime 재시작:** exponential backoff 재연결 후 reconnect 효과
- **Stream Deck App 재시작:** 디스크 캐시를 읽고 Runtime snapshot과 revision 비교
- **USB 재연결:** 15개 셀 barrier 후 reconnect 효과
- **프레임 손상/누락:** 해당 generation 전체 거부, 이전 완전한 화면 유지
- **일부 셀 미배치:** 액션 실행 금지, 배치 오류 화면과 Studio 안내
- **애니메이션 중 새 화면:** 이전 재생 취소, 최신 목표로 새 전환
- **플러그인 프로세스 종료:** Stream Deck App이 재시작하고 캐시에서 복구
- **Runtime 강제 종료:** heartbeat timeout 후 오프라인 화면과 입력 차단

generation은 임시 위치에 완성한 뒤 원자적으로 게시한다. 마지막으로 검증된 두 generation만 보존한다.

## 16. 보안 경계

- 서버는 `127.0.0.1`에만 bind한다.
- 플러그인 연결에는 설치 시 생성한 별도 토큰을 사용한다.
- 브라우저 Origin이 있는 Runtime API 요청은 기존 정책대로 거부한다.
- 플러그인에서 shell command 또는 앱 실행을 직접 수행하지 않는다.
- 키 이벤트는 Runtime의 현재 binding과 source/action 허용 규칙을 다시 검증한다.
- 이미지 크기, 프레임 수, message 크기와 duration을 제한한다.
- 플러그인은 Runtime이 게시한 콘텐츠 해시 자산만 읽는다.

## 17. 구현 순서

### 단계 1 — 계측과 승인 harness

- `willDisappear`, `willAppear`, cells-ready, 프레임 시작/종료 계측
- 잠금·해제 10회 결과 저장 형식
- PoC의 현재 270–278ms 크로스페이드 기준선 보존

완료 기준: Elgato warm-up, 장치 연결, 플러그인 복귀 시간을 분리해 보고한다.

### 단계 2 — 새 Studio 도메인

- `StudioDocument v2`
- 자산 저장소와 검증
- 배경, 고정 버튼, 동적 region, standby, motion
- 기존 `streamdeck.board`는 불러오지 않음

완료 기준: 빈 문서에서 배경과 버튼을 만들고 재시작 후 같은 초안을 복구한다.

### 단계 3 — 장치 독립 렌더러

- 480×272 전체 캔버스
- 공용 `DeviceGeometry`
- Studio와 headless 렌더 결과 일치

완료 기준: Studio 미리보기와 추출된 15개 키를 다시 합성한 픽셀 해시가 일치한다.

### 단계 4 — 애니메이션 컴파일러

- crossfade
- fade-through-black
- deadline 기반 frame plan
- 잠금 중 resume package 선행 생성

완료 기준: 늦은 프레임은 건너뛰고 마지막 프레임은 항상 정확히 전송한다.

### 단계 5 — Runtime gateway와 플러그인

- 인증 WebSocket
- presentation/key protocol
- 15-cell barrier
- 메모리/디스크 캐시
- stale input 차단

완료 기준: Runtime, 플러그인, USB 재시작 뒤 잘못된 액션 없이 최신 화면을 복원한다.

### 단계 6 — Studio UX

- 캔버스 중심 편집
- 대기화면 편집
- 움직임 preset과 속도
- 연결 및 적용 상태
- 전용 프로필 온보딩

완료 기준: 사용자가 JSON과 Stream Deck App의 개별 셀 설정 없이 배경, Firefox 버튼, unlock 효과를 적용한다.

### 단계 7 — 실기기 승인

- 잠금·해제 10회
- USB 분리/연결
- Runtime과 Stream Deck App 각각 재시작
- 전환 중 데이터 변경과 키 입력
- 픽셀 배치와 전체 화면 연속성 육안 확인

완료 기준: 성능표와 오류 처리 기준을 모두 만족한다.

### 단계 8 — 직접 HID 제거

- `@elgato-stream-deck/node` 제거
- `packages/streamdeck/hid.ts` 제거
- HID 전용 `DisplayLifecycle`과 host wiring 제거
- `hid:*` 진단 스크립트 제거
- 기존 `streamdeck:register`를 플러그인·프로필 상태를 확인하는 `streamdeck:setup`으로 교체
- 직접 HID 테스트와 문서 제거 또는 plugin gateway 테스트로 대체
- 제품 실행 경로에서 Stream Deck App을 필수 의존성으로 명시

완료 기준: 저장소와 배포물에 장치를 직접 여는 코드가 없고, 전체 검사와 실기기 승인 시나리오가 통과한다.

## 18. 출시 승인 기준

- Stream Deck App만 장치를 소유한다.
- 지원 장치에서 전체 배경의 방향, crop과 키 간 연속성이 Studio와 일치한다.
- 페이지 전환과 unlock 애니메이션이 deadline 기반으로 끝난다.
- 잠금 중 최신 데이터가 복귀 화면에 반영된다.
- 동적 버튼이 안정적인 좌표를 유지하고 stale 입력을 실행하지 않는다.
- Runtime 또는 플러그인 장애 시 임의 액션이 실행되지 않는다.
- Studio를 닫아도 Runtime과 플러그인은 계속 동작한다.
- 설치된 전용 프로필에 15개 셀이 빠짐없이 존재한다.
- 직접 HID 의존성과 운영 지침이 완전히 제거된다.

## 19. 기각한 대안

### PoC 파일 감시를 그대로 제품화

화면 적용은 단순하지만 키 입력, 연결 상태, revision, 인증과 재연결을 하나의 일관된 프로토콜로 다루기 어렵다. 파일은 애니메이션 캐시로 사용할 수 있지만 제어 채널이 될 수는 없다.

### 모든 로직을 플러그인에 포함

장치 접근은 단순해지지만 수집기, 명령 실행, Studio 서버와 상태 DB가 Stream Deck App이 관리하는 플러그인 프로세스 수명에 결합된다. 보안 경계와 테스트 seam이 악화된다.

### 직접 HID와 플러그인 동시 지원

장치 소유권 충돌을 다시 만들고 렌더링·수명주기·설치 경로를 두 벌로 유지해야 한다. 직접 HID는 전환기의 검증 기준으로만 남기고 제품 옵션으로 유지하지 않는다.

## 20. 후속 문서

이 설계가 검토된 뒤 별도의 구현 계획에서 파일 단위 변경, 테스트 순서와 커밋 단위를 정의한다. 구현 계획 승인 전에는 제품 코드를 변경하지 않는다.
