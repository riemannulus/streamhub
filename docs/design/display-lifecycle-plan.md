# 디스플레이 수명 관리 구현

사용자 승인: 종료·잠금·잠자기 자동 대기화면 복귀와 활성화 시 최신 화면 복구를 구현하고 커밋·푸시한다.

## 계약

core 신호 수명은 변경하지 않는다. 호스트가 macOS 세션 상태를 전달하고 Stream Deck 수명 관리자가 HID와 전송을 소유한다.

- unknown/inactive: 입력 차단, 진행 중 프레임 중단 요청, 이미 진행 중인 전송 종료 후 Show Logo, HID 닫기.
- active: 장치 열기, 최신 상태 전체 전송, 기존 눌림 해제 뒤 입력 허용.
- stopped: 최종 상태. 비동기 활성화가 뒤늦게 도착해도 다시 열지 않는다.
- disconnected/error: 현재 바인딩 무효화, 핸들 폐기, 다음 재시도에서 최신 상태 복구.
- 모니터 EOF/오류/heartbeat 만료: inactive로 처리한다.

정상 종료/잠금에서 대기화면 명령을 수행한다. USB가 이미 분리됐거나 SIGKILL/전원 차단된 순간의 전송은 보장하지 않는다. 잠자기 알림 처리는 OS가 USB를 중단하기 전 가능한 범위의 best effort다.

## 구현과 검증

- [x] packages/streamdeck/lifecycle.ts: 직렬화, 취소, timeout, 재접속, held-key 보호. 지연되는 가짜 장치로 race를 재현하는 테스트.
- [x] packages/host/native/session-monitor.swift + src/session-monitor.ts: NSWorkspace와 잠금 이벤트, 초기 상태, heartbeat, 종료 정리. Swift 실제 빌드 및 초기 상태 조회, 파서 테스트.
- [x] packages/streamdeck/render.ts + hid.ts: 72×72 정적 이미지와 실제 HID 연결. 렌더 결과 테스트 및 실기기 standby/resume/stop 검증.
- [x] host main/config: streamdeck.enabled로 옵트인, 최신 상태와 지속 연결, 종료 순서와 레이아웃 보존. 미설정 시 기존 HTTP 전용 실행 유지.
- [x] 전체 타입 검사/테스트(79개), Bun 빌드·데모, 별도 리뷰와 실제 잠금·해제 복귀 확인.

전달: 초기 main 커밋을 생성하고 origin/main에 푸시한다.

실제 focus/open action 실행은 이 변경에서 활성화하지 않는다. 탐색·핀만 물리 입력에 연결한다. macOS 잠금 분산 알림 이름과 잠금 딕셔너리 키는 공개 안정 API가 아니므로 OS 업그레이드 시 검증하고 감시 실패는 inactive로 처리한다.

구현: DisplayLifecycle 단일 pump로 작업을 합치고 timeout 핸들을 격리한다. host display 모듈은 데이터 조회 건강도와 OS 활성 상태를 함께 확인한다. 늦은 이전 연결 이벤트와 폐기된 key-up 바인딩도 차단한다. 실제 HID 시퀀스 검증에서 정상 대기/복원/종료 전송을 확인했다. 잠금 실기기 관찰 결과는 hid-validation.md에 별도 기록한다.
