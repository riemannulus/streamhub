# Studio M2 고급 동작 검증 기록

- 자동 검증 기준 커밋: 기록 시 `main` HEAD
- 자동 검증 날짜: 2026-09-11 (Asia/Seoul)
- 실기기 승인 상태: **대기** — 사용자가 장치 앞에서 아래 반복 검증을 완료해야 한다.

## 자동 통합 검증

2026-09-11 실행 결과: 저장소 전체 272개 테스트와 Stream Deck 플러그인 전용 6개 테스트가 모두 통과했고, TypeScript 검사, 브라우저/플러그인 빌드, diff 공백 검사도 성공했다.

`packages/host/src/advanced-actions.integration.test.ts`는 가짜 플러그인 시계, 실제 Presentation 서비스, 원자적 파일 토글 저장소와 가짜 leaf 실행기를 연결한다.

- 누르기, 두 번 누르기, 길게 누르기 중 정확히 한 분기만 실행한다.
- 순차 동작은 순서를 지키고, 병렬 동작은 각 leaf를 정확히 한 번 시작한다.
- 토글은 성공 후에만 바뀌고 Runtime 재시작 뒤 반대 분기를 실행한다.
- 페이지 변경, 잠금, 플러그인 연결 종료가 지연과 남은 leaf를 취소한다.
- 모든 완료 leaf의 호출 횟수를 URL별로 고정해 중복 실행을 탐지한다.

실행 명령:

```sh
bun test packages/host/src/advanced-actions.integration.test.ts
bun run check
bun run streamdeck:plugin:check
git diff --check
```

## 실기기 승인 환경

| 항목 | 기록 |
|---|---|
| Stream Deck 모델 | 대기 |
| 펌웨어 | 대기 |
| Stream Deck App 버전 | 대기 |
| macOS 버전 | 대기 |
| 검증 커밋 | 대기 |
| 시작 시각 | 대기 |
| 종료 시각 | 대기 |

## 사용자 보조 반복 체크리스트

한 테스트 페이지에 누르기/두 번/길게 분기 키, 지연 순차 키, 병렬 키, 영속 토글 키를 각각 구성한다.

- [ ] 일반 누르기 10회: 일반 분기 10회, 두 번/길게 분기 0회, 중복 효과 0회
- [ ] 두 번 누르기 10회: 두 번 분기 10회, 일반/길게 분기 0회, 중복 효과 0회
- [ ] 길게 누르기 10회: 길게 분기 10회, 일반/두 번 분기 0회, 중복 효과 0회
- [ ] 지연 순차 10회: 선언 순서 일치, 페이지 전환·잠금 중 남은 동작 취소
- [ ] 병렬 10회: 모든 leaf 한 번씩 시작, 중복 효과 0회
- [ ] 토글 10회와 Runtime 재시작: ON/OFF 교대, 재시작 뒤 마지막 상태 유지
- [ ] 플러그인 연결 종료 중 대기 동작: 남은 leaf 취소, 재연결 뒤 자동 재시도 없음

각 항목에는 관찰된 분기, 중복 효과 수, 취소 결과와 재시작 후 토글 상태를 적는다. 완료 전에는 M2의 **실기기 승인**을 주장하지 않는다.

## GitHub Actions 파이프라인 버튼 자동 검증

- 자동 검증 날짜: 2026-09-21 (Asia/Seoul)
- 실제 workflow dispatch: **수행하지 않음**
- 실제 장치 승인: **대기**

fake GitHub gateway, 실제 pipeline 상태 모듈, SQLite persistence seam, Presentation과 가짜 deck backend를 연결해 다음을 확인했다.

- RC 컷은 press에서만 dispatch 의도를 한 번 만든다.
- Prod 승격은 press에서 현재 run을 열고 700ms hold에서만 dispatch 의도를 만든다.
- `pending_deployments`의 정확한 `stg-backend` Environment가 주황 `승인 대기`로 표시된다.
- 승인 해제 뒤 배포 실패가 빨강으로 바뀌고 상태 버튼이 최초 실패 job URL을 연다.
- dispatch 도중 snapshot refresh가 진행 중 dispatch를 취소하지 않는다.
- Runtime 재시작 뒤 저장된 exact run ID와 실패 URL을 복구한다.
- dispatch보다 오래된 배포 run을 새 파이프라인에 연결하지 않는다.
- packaged Runtime에 `packages/github-actions`가 포함되고 test/private 파일은 제외된다.

자동 검증 결과:

```text
focused GitHub/Presentation/package suites: 65 pass, 0 fail
repository check: 446 pass, 0 fail
Stream Deck plugin check: 8 pass, 0 fail
TypeScript and git diff whitespace checks: pass
```

읽기 전용 GitHub smoke에서 Keychain 계정 `riemannulus` 인증, 최신 Stg run 조회, `pending_deployments` JSON 배열 응답을 확인했다. 토큰 평문은 읽거나 저장하지 않았다. `bun run github:register-crepe`는 현재 개발 설정과 applied/draft Studio 문서에 두 pipeline과 한 `crepe-release` 페이지를 중복 없이 등록했으며 workflow는 실행하지 않았다.
