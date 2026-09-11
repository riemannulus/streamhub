import { configPath, updateConfig } from '../packages/host/src/config';
if (process.argv.length > 2) {
  console.error('사용법: bun run streamdeck:register');
  process.exit(1);
}

try {
  updateConfig(config => ({ ...config, display:{...config.display,mode:'hid'} }));
  console.log('Stream Deck 사용을 설정에 등록했습니다.');
  console.log(`설정: ${configPath()}`);
  console.log('bun start로 실행하세요. 이미 실행 중이면 종료한 뒤 다시 시작하세요.');
} catch {
  console.error('Stream Deck 등록에 실패했습니다. 설정 파일 형식과 쓰기 권한을 확인하세요.');
  process.exitCode = 1;
}
