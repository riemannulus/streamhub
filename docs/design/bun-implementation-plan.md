# Bun 기반 첫 실행 단위

기준: [v4 설계](local-signal-bus-v4.md). 사용자가 Bun으로 검증과 구현 시작을 요청했다.

목표: live 신호를 인증된 HTTP로 수락하고 SQLite에 보존하며, membership 교정과 12개 단위 안정적인 배치를 테스트 및 실행 가능한 CLI 데모로 검증한다.

구조: core는 외부 의존성 없는 상태 전이, host는 Bun HTTP/SQLite, streamdeck는 장치 독립적인 배치/입력 모델. 장치와 앱이 없는 환경에서 HID 또는 실제 focus 성공을 주장하지 않는다.

## 작업

- [x] core/src/index.ts + index.test.ts: source/id 격리, delivery 중복 방지, snapshot watermark와 연속 누락 교정. `initialState()`, `applyCommand(state, command, now)`, `SignalRecord`를 공개한다. 테스트 먼저 실행하고 구현한다.
- [x] streamdeck/index.ts + deck.test.ts: 빈칸 유지, 13번째 세션 화면, 키 down/up revision 검증. `SessionDeck.update(records)`와 `page(index)`를 공개한다. 테스트 먼저 실행하고 구현한다.
- [x] host/src/store.ts + store.test.ts: SQLite 트랜잭션으로 core 상태를 저장하고 실패 시 메모리 상태도 보존한다. 실제 임시 DB로 재시작 복구를 테스트한다.
- [x] host/src/server.ts + server.test.ts: source별 인증, 엄격한 live 입력 검증, 읽기 인증, 크기 상한, origin 차단. 실제 Bun.serve와 HTTP 요청으로 검증한다.
- [x] scripts/demo.ts: 임시 DB에서 13세션 입력 → 갱신 → 스냅샷 교정 → 재시작 시나리오를 실행해 결과를 출력한다. bun run check 및 bun run demo를 최종 실행한다.
- [x] 독립 코드 검토로 누락을 수정하고 README에 실행법, 검증 결과, 미구현 하드웨어 연동을 기록한다.

이번 실행 단위는 v4 A의 기반이다. 실제 adapter·정적 이미지 전송은 앱/장치 계약 검증 뒤 연결한다. 초기 저장 구현은 source당 1,000개와 전체 10,000개의 live, 24시간 delivery 기록 상한으로 제한한다. 외부 입력에는 membership을 노출하지 않는다.

검증 명령: `bun run typecheck`, `bun test`, `bun run demo`.

초기 검증 결과: Bun 1.4.0에서 타입 검사 및 47개 테스트(210 assertions), 13세션 통합 데모 통과. 추가로 프로세스 그룹 timeout, SQLite 호스트 소유 잠금, 주기 수집과 stale 만료를 구현했다. 이후 실제 HID와 자동 대기화면 복귀를 구현했으며 [후속 구현 기록](display-lifecycle-plan.md)과 [실기기 검증](hid-validation.md)에 결과를 남긴다. 실제 앱 focus는 아직 연결하지 않았다.
