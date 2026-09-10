import {readConfig} from '../packages/host/src/config';
import {runCommandSource} from '../packages/sources/command';
const args=process.argv.slice(2);
const controller=new AbortController();
const interrupt=()=>controller.abort(130),terminate=()=>controller.abort(143);
process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
try{
  const fields:Record<string,string>={};
  let commandStart=0;
  while(['--source','--id','--label'].includes(args[commandStart])){
    const flag=args[commandStart],value=args[commandStart+1];
    if(!value||Object.hasOwn(fields,flag))throw new Error('사용법: bun run source:run [--source NAME --id ID --label LABEL] [-- COMMAND ARG ...]');
    fields[flag]=value;commandStart+=2;
  }
  if(args[commandStart]==='--')commandStart++;
  const argv=args.length>commandStart?args.slice(commandStart):[process.execPath,'run','check'];
  const result=await runCommandSource(readConfig(),{source:fields['--source'],id:fields['--id'],label:fields['--label'],argv,signal:controller.signal});
  if(result.publicationError)console.error(result.publicationError);
  process.exitCode=result.exitCode;
}catch(error){console.error(error instanceof Error?error.message:'검사 실행에 실패했습니다.');process.exitCode=1;}
finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
