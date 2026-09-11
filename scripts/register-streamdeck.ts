import { configPath, updateConfig } from '../packages/host/src/config';
import { readFileSync } from 'node:fs';
import { validatePageConfig } from '../packages/streamdeck/pages';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--pages')) {
  console.error('사용법: bun run streamdeck:register [--pages FILE]');
  process.exit(1);
}

try {
  const board = args.length ? validatePageConfig(JSON.parse(readFileSync(args[1]!, 'utf8'))) : undefined;
  updateConfig(config => ({ ...config, display:{...config.display,mode:'hid'},streamdeck: { ...config.streamdeck, enabled: true, ...(board ? {board} : {}) },streamdeckPlugin:config.streamdeckPlugin&&{...config.streamdeckPlugin,enabled:false} }));
  console.log('Stream Deck 사용을 설정에 등록했습니다.');
  console.log(`설정: ${configPath()}`);
  console.log('bun start로 실행하세요. 이미 실행 중이면 종료한 뒤 다시 시작하세요.');
} catch {
  console.error('Stream Deck 등록에 실패했습니다. 설정 파일 형식과 쓰기 권한을 확인하세요.');
  process.exitCode = 1;
}
