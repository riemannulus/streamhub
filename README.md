# Streamhub

로컬 신호 버스의 Bun 기반 첫 구현입니다. `live` 신호를 받아 보존하고, 전체 목록으로 생존 여부를 교정하며, Stream Deck MK.2에 세션 보드를 표시합니다. 종료·잠금 시 기본 대기화면으로 복귀합니다.

## 실행

Bun **1.4.0**으로 검증했습니다. proto 사용 시 `.prototools`가 같은 버전을 선택합니다.

```sh
bun install --frozen-lockfile
bun run check
bun run demo
```

`check`는 TypeScript 검사와 Bun 테스트를 실행합니다. macOS에서는 Swift 잠금 상태 회귀 테스트도 컴파일하므로 Xcode Command Line Tools가 필요합니다. HTTP 통합 테스트는 임시 loopback 포트를 사용합니다. `demo`는 임시 DB/서버에서 13개 세션 입력, 동시 push와 스냅샷, 실패한 수집, 두 번 누락 후 철회, 재시작 복구를 실행하고 자원을 정리합니다.

지속 실행과 샘플 입력:

```sh
bun start
```

다른 터미널에서:

```sh
bun run client push demo examples/session.json sample-delivery-1
bun run client list
bun run client deck
bun run client remove demo example-session sample-removal-1
```

첫 실행은 `.streamhub/config.json`에 관리자 토큰과 `demo` 소스 토큰을 생성합니다. 파일은 0600, 새 디렉터리는 0700 권한이며 토큰을 콘솔에 출력하지 않습니다. DB도 같은 디렉터리에 둡니다. `STREAMHUB_CONFIG=/absolute/path/config.json`으로 위치를 바꿀 수 있습니다. 서버는 `127.0.0.1:31415`에만 바인딩합니다. Ctrl-C로 종료합니다.

CLI가 설정의 토큰을 읽어 요청합니다. 재시도는 같은 delivery id를 사용하고, 내용을 바꾸는 갱신은 새 delivery id를 사용합니다. 같은 delivery id에 다른 내용을 보내면 충돌로 거부합니다.

## 지금 동작하는 범위

- 순수 TypeScript core: `(source,id)` 격리, live 갱신/철회, 24시간 재전송 중복 방지.
- Bun HTTP: source별 쓰기 인증, 관리자 읽기 인증, 엄격한 JSON 검증, Origin 차단, 1 MiB 입력 제한.
- Bun SQLite: 명령 단위 원자적 저장, 재시작 시 stale 복구, 같은 DB에 대한 중복 호스트 실행 방지. 프로세스가 죽으면 OS가 DB 소유 잠금을 해제합니다.
- membership: 수집 중 push/remove 보호, 연속 두 번 누락 후 철회, 실패 시 기존 신호 유지, stale 전이.
- 논리적인 Stream Deck 뷰: 12개 내용 키, 13번째 세션의 다음 화면, 빈칸 유지, urgent 핀, down/up 사이 바뀐 대상 실행 방지, 레이아웃 내보내기/복원.
- 선택적으로 켜는 실제 HID 출력: 전체 프레임 렌더링, 탐색·핀 입력, 잠금·종료 시 Show Logo, 활성화 시 최신 상태 복구.
- 로컬 action 실행 모듈: 등록·소스 권한·인자 정규식 검증, 셸 없는 argv, 프로세스 그룹 timeout, 출력 상한. 현재 신호의 버튼을 실행하는 HTTP 경로는 제공하지 않습니다.

## 신뢰하는 목록 수집기 연결

설정 파일의 `collectors`에 로컬 프로그램을 등록하면 시작 시 한 번, 이후 주기적으로 실행합니다. 같은 소스의 수집은 겹치지 않습니다.

```json
{
  "collectors": [
    {
      "source": "demo",
      "exec": ["/absolute/path/list-sessions"],
      "intervalMs": 20000,
      "timeoutMs": 5000
    }
  ]
}
```

위 항목을 생성된 설정에 추가합니다. `exec` 첫 원소는 실제 실행 파일의 절대 경로여야 합니다. `~`나 셸 표현식은 확장하지 않습니다. 기본 환경은 PATH만 전달하므로 환경 의존적인 수집기는 자체 설정을 읽도록 만듭니다. `stdout`에는 아래 형태의 **완전한 JSON 하나**를 출력하고 exit 0으로 종료해야 합니다.

```json
{
  "ids": ["session-1"],
  "discoveries": [
    { "kind": "live", "id": "session-1", "level": "info", "label": "상태 미확인" }
  ]
}
```

`discoveries`는 없는 신호만 생성하며 stale로 시작합니다. 기존 urgent를 덮어쓰지 않습니다. 이미 메타데이터가 있는 항목은 ids에만 넣어도 됩니다. 성공한 빈 ids 두 번은 해당 source의 세션을 철회하므로, 저장된 기록·부분 조회·캐시를 살아 있는 세션의 전체 목록처럼 반환하면 안 됩니다.

실패는 즉시 health의 degraded로 보입니다. 마지막 성공(없으면 첫 수집 시작)으로부터 `max(3 × intervalMs, 60초)`가 지나면 다음 scheduler tick에 소스 신호를 stale로 표시합니다. 실패를 빈 목록으로 처리하지 않습니다. `/v1/state`에 health가 함께 포함됩니다.

## 아직 연결하지 않은 것

- 실제 cmux/Orca/Claude 세션 adapter와 검증된 focus 경로.
- event/gauge, ack/TTL, 선언 jq 매핑, JSONL 장기 프로세스, Frame 출력.
- 외부 버튼 액션 실행. 대상 소유권·현재 revision·중복 실행·외부 결과 불명확 처리까지 연결한 뒤 활성화해야 합니다.

검증 환경에서 cmux CLI는 없었고 Orca는 실행 대기 timeout이 발생했습니다. 실제 앱 focus는 검증하지 않았습니다. 이후 연결된 MK.2의 독립 HID 출력은 아래 진단으로 확인했습니다.

저장은 초기 구현으로 core 상태 전체를 SQLite 한 행에 보존합니다. source당 1,000개/전체 10,000개 활성 신호, delivery 기록 100,000개 상한이 있으며 고빈도 입력 성능은 아직 측정하지 않았습니다. macOS를 대상으로 검증했으며 실행 모듈은 로컬 신뢰 코드의 sandbox가 아닙니다.

## 코드와 설계

- `packages/core/src`: 장치·제품·파일 입출력에 의존하지 않는 상태 전이.
- `packages/host/src`: 저장, HTTP, 검증, 수집, 실행 관리.
- `packages/streamdeck`: 논리 배치, 입력 의도, 렌더링과 HID 수명 관리.
- [v4 설계](docs/design/local-signal-bus-v4.md), [이번 구현 범위](docs/design/bun-implementation-plan.md).

사용한 Bun 인터페이스: [SQLite](https://bun.sh/docs/runtime/sqlite), [HTTP server](https://bun.sh/docs/runtime/http/server), [test runner](https://bun.sh/docs/test).

## 실제 HID 출력 진단

```sh
bun run hid:check --list          # 연결 장치 읽기
bun run hid:check                 # 5초간 진단 후 기본 대기화면 복귀
bun run hid:check --listen=45     # 45초간 down/up 기록 후 기본 대기화면 복귀
bun run hid:restore               # 지금 기본 대기화면으로 복귀
```

15키·72×72 장치가 정확히 한 대일 때만 출력합니다. `01–15` 번호, 행별 빨강/초록/파랑 띠, 좌상단 노란 표시로 방향과 매핑을 확인합니다. 버튼에 액션을 연결하지 않으며 테스트 종료 후 Show Logo 명령으로 기본 대기화면에 복귀하고 HID를 닫습니다. 패턴을 남기려면 `--keep-pattern`을 명시합니다. 기존 커스텀 화면을 읽어서 복구하는 기능은 없습니다.

Bun 1.4.0에서 실제 **Stream Deck MK.2 / 펌웨어 1.02.000**을 열고 15개 키의 이미지 전송과 전송 후 펌웨어 조회를 확인했습니다. 결과와 키 입력은 `.streamhub/hid-check.json`에 저장됩니다. 성공한 HID 쓰기는 사람이 화면을 확인했다는 증거와 별개이며, 지속 FPS 보장을 측정하는 부하 테스트도 아닙니다.

`@elgato-stream-deck/node` 7.6.3과 포함된 node-hid prebuild를 사용합니다. 진단과 데몬의 지속 출력 모두 실제 HID를 사용합니다. 아래 설정으로 데몬 출력을 켤 수 있습니다.

실기기에서 사용자가 패턴의 정상 표시를 확인했고, 01번과 15번 키의 down/up도 수신했습니다. [실기기 검증 기록](docs/design/hid-validation.md)을 참고하세요.


## 자동 대기화면과 세션 보드

생성된 `.streamhub/config.json`에 다음 항목을 추가한 뒤 `bun start`로 실행합니다.

```json
"streamdeck": { "enabled": true }
```

설정이 없거나 false이면 기존 HTTP 전용 실행을 유지합니다. 활성화하면 호스트가 100ms마다 최신 신호를 확인하고 바뀐 화면만 요청합니다. 연결된 장치는 15키·72×72 한 대여야 합니다. Elgato 앱과 동시에 이미지를 쓰면 화면이 경쟁하므로 직접 HID 사용 중에는 해당 앱을 종료합니다.

| 상황 | 처리 |
|---|---|
| 시작 시 잠금 상태 불명·모니터 부재 | 기본 대기화면 유지, 입력 차단 |
| 화면 잠금·세션 비활성·디스플레이 잠자기 | 진행 중 프레임 중단 요청 → 대기화면 → HID 해제 |
| 잠금 해제·깨어남 | 최신 전체 화면 재전송, 기존 눌림 해제 뒤 탐색 허용 |
| SIGINT·SIGTERM 정상 종료 | 대기화면과 HID 정리를 HTTP/DB 종료보다 먼저 수행 |
| USB 연결 오류 | 이전 핸들 폐기, 2초 간격 재시도와 전체 화면 복구 |
| 모니터 종료·6초 heartbeat 누락 | 활성 출력을 차단하고 대기화면 복귀 |

슬롯/페이지 배치는 SQLite에 보존합니다. 물리 버튼은 페이지 탐색과 핀 이동만 수행하며 focus/open/승인 액션은 아직 실행하지 않습니다. CLI `deck`은 별도의 일회성 텍스트 미리보기입니다.

macOS 모니터는 Swift helper를 소스 해시별로 `.streamhub/native`에 빌드하므로 **Xcode Command Line Tools**가 필요합니다. 빌드나 세션 확인이 실패하면 화면 출력을 허용하지 않습니다. 잠자기·세션 전환은 NSWorkspace, 잠금은 macOS 분산 알림과 세션 딕셔너리를 사용합니다. 잠금 알림/키는 Apple의 공개 안정 계약이 아니므로 OS 업데이트 시 다시 확인해야 합니다.

OS가 이미 USB를 중단한 잠자기, USB 분리, SIGKILL, 전원 차단 순간에는 명령 전송을 보장할 수 없습니다. 전송 timeout 이후에는 실패한 핸들을 재사용하지 않습니다. `hid:restore`는 수동 복구 경로입니다. 기본 대기화면은 Show Logo이며 커스텀 스크린세이버를 복구하는 명령은 아닙니다.

```sh
bun run hid:lifecycle-check           # 실제 HID에서 suspend/resume/stop 시퀀스
bun run hid:lifecycle-check --session # 실제 macOS 잠금/해제를 5분 관찰
```

[디스플레이 수명 관리 설계](docs/design/display-lifecycle-plan.md).
