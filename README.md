# Streamhub

Streamhub는 Stream Deck 전체를 하나의 화면처럼 꾸미고, 각 키에 앱·웹사이트·파일·단축키·페이지 이동 같은 동작을 연결하는 로컬 Runtime과 브라우저 Studio입니다. HID 직접 연결의 빠른 화면 전환과 공식 Stream Deck 플러그인의 편한 앱 공존 방식을 모두 지원합니다.

> `0.1.0-preview.1`은 Apple Silicon Mac용 서명·공증 전 Developer Preview입니다. macOS 13 이상, [Bun 1.4.0](https://bun.sh/)과 Xcode Command Line Tools가 필요합니다.

## 설치와 첫 실행

압축 파일이 있는 터미널에서 다음 순서로 실행합니다.

```sh
tar -xzf streamhub-0.1.0-preview.1-macos-arm64.tar.gz
cd streamhub-0.1.0-preview.1-macos-arm64
./install.sh
streamhub setup
streamhub start
```

`streamhub setup`에서 HID 또는 Plugin을 고릅니다. Runtime은 실행 중인 터미널에서 계속 동작하므로, 새 터미널을 열어 Studio를 실행합니다.

```sh
streamhub studio
```

Studio는 `http://127.0.0.1:31416`에서 열립니다. 브라우저를 자동으로 열지 않으려면 `streamhub studio --no-open`을 사용합니다. Runtime과 Studio를 종료할 때는 각각 실행한 터미널에서 Ctrl-C를 누릅니다.

설치 명령이 보이지 않으면 우선 절대 경로로 확인합니다.

```sh
~/.local/bin/streamhub version
```

이 명령이 동작하면 셸 설정에 `~/.local/bin`을 PATH로 추가한 뒤 터미널을 다시 여세요.

## 연결 방식 선택

두 모드는 같은 Studio 문서와 버튼 동작을 사용합니다. 모드를 바꾼 뒤에는 Runtime을 Ctrl-C로 종료하고 `streamhub start`로 다시 시작해야 합니다. 실패하더라도 다른 모드로 자동 전환하지 않습니다.

### HID

```sh
streamhub setup hid
streamhub start
```

Streamhub가 장치를 직접 소유합니다. Stream Deck 앱을 메뉴 막대에서도 완전히 종료한 뒤 시작하세요. 화면 복구와 애니메이션이 더 빠르고 부드러운 방식입니다. Stream Deck 앱의 프로필과 다른 플러그인은 동시에 사용할 수 없습니다.

### Plugin

```sh
streamhub setup plugin
streamhub start
```

공식 Stream Deck 앱이 장치를 소유하고 Streamhub 플러그인이 화면과 입력을 전달합니다. 설치된 프로필과 다른 Stream Deck 기능을 함께 관리하기 쉽지만, 앱과 SDK 전달 구간 때문에 잠금 해제 복구와 애니메이션이 HID보다 느릴 수 있습니다. 설정 후 Stream Deck 앱을 실행하거나 한 번 재시작하세요.

현재 상태는 자격 증명을 노출하지 않는 다음 명령으로 확인할 수 있습니다.

```sh
streamhub status
```

`configuredMode`와 `activeMode`가 다르거나 `restartRequired`가 `true`이면 Runtime을 재시작해야 합니다.

## Studio에서 할 수 있는 일

왼쪽에서 페이지를 만들고 복제·삭제·정렬하며 기본 페이지를 정합니다. 가운데 5×3 캔버스에는 배경 이미지와 대기 화면을 넣고, 오른쪽에서는 선택한 키의 동작과 표시를 편집합니다.

- 앱, 웹사이트, 파일·폴더, 단축키, 텍스트·미디어, 등록된 로컬 명령을 실행합니다.
- 이전·다음·특정 페이지 이동과 자동 페이지 전환 복귀 버튼을 만듭니다.
- 버튼마다 `아이콘 + 라벨`, `아이콘만`, `라벨만`, `숨김`을 고릅니다. 숨김 버튼은 배경 위의 투명한 실행 영역으로 쓸 수 있습니다.
- Stream Deck 앱에 설치된 아이콘팩과 Mac 앱 아이콘을 불러오거나 직접 이미지로 덮어씁니다.
- 페이지 전환, 잠금 해제와 재연결 애니메이션을 설정합니다.
- 여러 동작, 토글, 두 번 누르기와 길게 누르기를 구성합니다.

편집을 마치면 **장치에 적용**을 누릅니다. Runtime이 꺼져 있으면 문서는 저장되며 다음 시작 때 장치에 적용됩니다. 다른 Studio나 Runtime에서 문서를 먼저 바꿨다면 충돌 안내에 따라 다시 불러오세요.

Plugin 모드의 대기 화면은 플러그인이 키를 소유하는 동안 표시됩니다. Stream Deck 앱 자체의 네이티브 스크린세이버 이미지는 공개 플러그인 API로 바꿀 수 없으므로 Stream Deck 앱에서 별도로 설정해야 합니다.

## 업데이트와 제거

새 버전의 압축 파일을 풀고 그 안에서 `./install.sh`를 다시 실행하면 해당 버전을 설치합니다. 설정, Studio 문서와 이미지 같은 사용자 데이터는 다음 위치에 유지됩니다.

```text
~/Library/Application Support/Streamhub/data
```

프로그램만 제거하려면 실행 중인 Runtime과 Studio를 먼저 Ctrl-C로 끝낸 뒤 다음 명령을 사용합니다.

```sh
streamhub uninstall
```

제거는 현재 버전과 `~/.local/bin/streamhub` 링크만 지웁니다. 사용자 데이터, 설치된 Stream Deck 플러그인과 연결 정보는 보존됩니다.

## 문제 해결

**`streamhub` 명령을 찾지 못함**

`~/.local/bin/streamhub version`으로 설치를 확인하고 `~/.local/bin`을 PATH에 추가합니다.

**31415 또는 31416 포트를 이미 사용 중이라고 나옴**

다른 터미널에서 실행 중인 Streamhub Runtime이나 Studio를 찾아 Ctrl-C로 종료하세요. `lsof -nP -iTCP:31415 -sTCP:LISTEN`과 `lsof -nP -iTCP:31416 -sTCP:LISTEN`으로 소유 프로세스를 확인할 수 있습니다.

**HID 모드에서 장치를 열 수 없음**

Stream Deck 앱을 창만 닫지 말고 메뉴 막대에서 완전히 종료하고 USB 연결을 확인한 뒤 Runtime을 다시 시작합니다.

**Plugin 모드가 연결되지 않음**

Stream Deck 앱을 실행하거나 재시작하고 Streamhub 프로필이 설치되었는지 확인한 뒤 `streamhub status`를 봅니다. 모드를 방금 바꿨다면 Runtime도 재시작합니다.

**앱·파일 선택이나 창 정보 기능이 동작하지 않음**

macOS 시스템 설정의 개인정보 보호 및 보안에서 터미널 또는 Streamhub를 실행한 앱에 손쉬운 사용 권한을 허용합니다.

**Swift helper 컴파일 또는 `xcrun` 오류**

`xcode-select --install`을 실행해 Xcode Command Line Tools를 설치한 뒤 다시 시작합니다.

이 Preview는 아직 서명·공증되지 않았습니다. 출처를 신뢰할 수 있는 배포 파일인지 확인하고 사용하세요. 개발과 소스 빌드 정보는 [DEVELOPMENT.md](DEVELOPMENT.md)에 있습니다.
