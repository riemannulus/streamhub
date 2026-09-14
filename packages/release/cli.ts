import type {DisplayMode} from '../host/src/config';
import type {StudioDisplayStatus} from '../host/src/runtime';
import type {DaemonStatus,RuntimeDaemon} from './daemon';
import type {SetupResult} from './setup';

export type DaemonCommand={type:'daemon';operation:'enable'|'disable'|'restart'|'status'}|{type:'daemon';operation:'logs';follow:boolean};
export type PreviewCommand={type:'setup';mode?:'hid'|'plugin'}|{type:'start'}|{type:'studio';open:boolean}|{type:'status'}|{type:'version'}|{type:'uninstall'}|DaemonCommand;
export type PreviewDependencies={
  chooseMode:()=>Promise<'hid'|'plugin'>;
  setup:(mode:'hid'|'plugin')=>Promise<SetupResult>;
  runChild:(entry:string,args:string[])=>Promise<number>;
  status:()=>Promise<StudioDisplayStatus>;
  uninstall:()=>Promise<number>;
  daemon:RuntimeDaemon;
  readDaemonLog:()=>string;
  followDaemonLog:()=>Promise<number>;
  write:(value:string)=>void;
  runtimeEntry:string;
  studioEntry:string;
  version:string;
};

const usage='Usage: streamhub setup [hid|plugin] | start | studio [--no-open] | status | version | uninstall | daemon enable|disable|restart|status|logs [--follow]';
export function parsePreviewCommand(argv:readonly string[]):PreviewCommand{
  if(argv[0]==='setup'&&argv.length<=2&&(argv[1]===undefined||argv[1]==='hid'||argv[1]==='plugin'))return{type:'setup',...(argv[1]?{mode:argv[1]}:{})};
  if(argv[0]==='start'&&argv.length===1)return{type:'start'};
  if(argv[0]==='studio'&&(argv.length===1||(argv.length===2&&argv[1]==='--no-open')))return{type:'studio',open:argv.length===1};
  if(argv[0]==='status'&&argv.length===1)return{type:'status'};
  if(argv[0]==='version'&&argv.length===1)return{type:'version'};
  if(argv[0]==='uninstall'&&argv.length===1)return{type:'uninstall'};
  if(argv[0]==='daemon'&&argv.length===2&&(['enable','disable','restart','status'] as const).includes(argv[1] as 'enable'|'disable'|'restart'|'status'))return{type:'daemon',operation:argv[1] as 'enable'|'disable'|'restart'|'status'};
  if(argv[0]==='daemon'&&(argv.length===2||argv.length===3)&&argv[1]==='logs'&&(argv.length===2||argv[2]==='--follow'))return{type:'daemon',operation:'logs',follow:argv[2]==='--follow'};
  throw new Error(usage);
}

const modes=new Set<DisplayMode>(['off','hid','plugin']),states=new Set<StudioDisplayStatus['state']>(['off','connecting','ready','recovering','unavailable']);
export function sanitizeRuntimeStatus(configuredMode:DisplayMode,value:unknown):StudioDisplayStatus{
  if(!value||typeof value!=='object'||Array.isArray(value))return{configuredMode,activeMode:'off',state:'unavailable',restartRequired:configuredMode!=='off',message:'Runtime 상태를 확인하지 못했습니다.'};
  const raw=value as Record<string,unknown>,activeMode=modes.has(raw.activeMode as DisplayMode)?raw.activeMode as DisplayMode:'off',state=states.has(raw.state as StudioDisplayStatus['state'])?raw.state as StudioDisplayStatus['state']:'unavailable';
  const valid=activeMode!=='off'||raw.activeMode==='off';const message=typeof raw.message==='string'&&raw.message.length>0&&raw.message.length<=300?raw.message:undefined;
  if(!valid||!states.has(raw.state as StudioDisplayStatus['state']))return{configuredMode,activeMode:'off',state:'unavailable',restartRequired:configuredMode!=='off',message:'Runtime 상태를 확인하지 못했습니다.'};
  return{configuredMode,activeMode,state,restartRequired:configuredMode!==activeMode,...(message?{message}:{})};
}

function sanitizeDaemonStatus(value:DaemonStatus):DaemonStatus{
  const raw=value as Record<string,unknown>,pid=raw.pid,lastExitStatus=raw.lastExitStatus;
  return{
    enabled:raw.enabled===true,
    loaded:raw.loaded===true,
    running:raw.running===true,
    ...(typeof pid==='number'&&Number.isSafeInteger(pid)&&pid>0?{pid}:{}),
    ...(typeof lastExitStatus==='number'&&Number.isSafeInteger(lastExitStatus)&&lastExitStatus>=-2147483648&&lastExitStatus<=2147483647?{lastExitStatus}:{}),
  };
}

function publicRuntimeStatus(value:StudioDisplayStatus):StudioDisplayStatus{
  const configuredMode=modes.has((value as Record<string,unknown>).configuredMode as DisplayMode)?(value as Record<string,unknown>).configuredMode as DisplayMode:'off';
  return sanitizeRuntimeStatus(configuredMode,value);
}

export async function main(argv:readonly string[],deps:PreviewDependencies):Promise<number>{
  let command:PreviewCommand;try{command=parsePreviewCommand(argv);}catch(error){deps.write(error instanceof Error?error.message:usage);return 2;}
  try{
    if(command.type==='setup'){
      const mode=command.mode??await deps.chooseMode(),result=await deps.setup(mode),daemon=await deps.daemon.status();
      deps.write(daemon.enabled?`${result.guidance}\nRun streamhub daemon restart to apply the display setting.`:result.guidance);return 0;
    }
    if(command.type==='start'){
      if((await deps.daemon.status()).loaded){deps.write('Runtime daemon is enabled. Run streamhub daemon disable first.');return 1;}
      return await deps.runChild(deps.runtimeEntry,[]);
    }
    if(command.type==='studio')return await deps.runChild(deps.studioEntry,command.open?[]:['--no-open']);
    if(command.type==='status'){deps.write(JSON.stringify(await deps.status(),null,2));return 0;}
    if(command.type==='version'){deps.write(`Streamhub ${deps.version} (macos-arm64)`);return 0;}
    if(command.type==='daemon'){
      if(command.operation==='logs')return command.follow?await deps.followDaemonLog():(deps.write(deps.readDaemonLog()),0);
      if(command.operation==='status'){deps.write(JSON.stringify({daemon:sanitizeDaemonStatus(await deps.daemon.status()),runtime:publicRuntimeStatus(await deps.status())},null,2));return 0;}
      await deps.daemon[command.operation]();deps.write(`Runtime daemon ${command.operation==='enable'?'enabled':command.operation==='disable'?'disabled':'restarted'}.`);return 0;
    }
    return await deps.uninstall();
  }catch(error){deps.write(error instanceof Error?error.message:'Streamhub 명령을 완료하지 못했습니다.');return 1;}
}
