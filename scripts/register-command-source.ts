import {resolve} from 'node:path';
import {configPath,updateConfig} from '../packages/host/src/config';
import {registerCommandSource} from '../packages/sources/command';
const args=process.argv.slice(2);
try{
  const argv=args[0]==='--'?args.slice(1):args;
  if(args[0]==='--'&&!argv.length)throw new Error('-- 뒤에 실행할 명령을 지정하세요.');
  updateConfig(config=>registerCommandSource(config,{configFile:configPath(),cwd:process.cwd(),bun:process.execPath,script:resolve(import.meta.dir,'run-command-source.ts'),...(argv.length?{argv}:{})}));
  console.log('로컬 검사 소스와 run-checks 동작을 등록했습니다.');
  console.log('Studio에서 “등록된 명령” 버튼을 추가한 뒤 bun run source:run으로 검사를 실행할 수 있습니다.');
}catch(error){console.error(error instanceof Error?error.message:'소스 등록에 실패했습니다.');process.exitCode=1;}
