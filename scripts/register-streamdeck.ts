import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import { configPath } from '../packages/host/src/config';
import {setupDisplayMode} from '../packages/release/setup';
if (process.argv.length > 2) {
  console.error('사용법: bun run streamdeck:register');
  process.exit(1);
}

try {
  const result=await setupDisplayMode({mode:'hid',packageRoot:resolve('.'),applicationSupport:join(homedir(),'Library','Application Support')});
  console.log('Stream Deck 사용을 설정에 등록했습니다.');
  console.log(`설정: ${configPath()}`);
  console.log(result.guidance.replace('streamhub start','bun start'));
} catch {
  console.error('Stream Deck 등록에 실패했습니다. 설정 파일 형식과 쓰기 권한을 확인하세요.');
  process.exitCode = 1;
}
