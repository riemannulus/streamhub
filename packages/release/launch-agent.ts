export const runtimeLabel='com.streamhub.runtime' as const;

export type LaunchAgentInput={
  home:string;
  uid:number;
  bunPath:string;
  packageRoot:string;
};

export type LaunchAgentPaths={
  label:typeof runtimeLabel;
  domain:string;
  service:string;
  plistPath:string;
  configPath:string;
  logPath:string;
  previousLogPath:string;
  runtimePath:string;
};

export type LaunchctlState={
  loaded:boolean;
  running:boolean;
  pid?:number;
  lastExitStatus?:number;
};

const ownershipComment='<!-- Managed by Streamhub Preview -->';

function fail(message:string):never{
  throw new Error(`Invalid LaunchAgent input: ${message}`);
}

function assertAbsolutePath(name:string,value:string):void{
  if(value.includes('\0')) fail(`${name} must not contain NUL`);
  if(!value.startsWith('/')) fail(`${name} must be an absolute path`);
  if(value.split('/').some((segment,index)=>index>0&&(segment===''||segment==='.'||segment==='..'))){
    fail(`${name} must not contain empty, dot, or parent segments`);
  }
}

function applicationRoot(packageRoot:string):string{
  const segments=packageRoot.split('/');
  if(segments.length<4||segments.at(-2)!=='app'||!segments.at(-1)){
    fail('packageRoot must have the shape <applicationRoot>/app/<version>');
  }
  const root=segments.slice(0,-2).join('/');
  if(root.split('/').at(-1)!=='Streamhub'){
    fail('packageRoot application root basename must be Streamhub');
  }
  return root;
}

function validateInput(input:LaunchAgentInput):void{
  assertAbsolutePath('home',input.home);
  assertAbsolutePath('bunPath',input.bunPath);
  assertAbsolutePath('packageRoot',input.packageRoot);
  if(!Number.isInteger(input.uid)||input.uid<=0) fail('uid must be a positive integer');
  applicationRoot(input.packageRoot);
}

function underHome(home:string,path:string):string{
  return `${home}/${path}`;
}

function xmlEscape(value:string):string{
  return value.replace(/[&<>"']/g,character=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&apos;',
  })[character]!);
}

function xmlText(value:string):string{
  return `<string>${xmlEscape(value)}</string>`;
}

export function launchAgentPaths(input:LaunchAgentInput):LaunchAgentPaths{
  validateInput(input);
  const dataPath=underHome(input.home,'Library/Application Support/Streamhub/data');
  const domain=`gui/${input.uid}`;
  return {
    label:runtimeLabel,
    domain,
    service:`${domain}/${runtimeLabel}`,
    plistPath:underHome(input.home,`Library/LaunchAgents/${runtimeLabel}.plist`),
    configPath:`${dataPath}/config.json`,
    logPath:`${dataPath}/logs/runtime.log`,
    previousLogPath:`${dataPath}/logs/runtime.log.1`,
    runtimePath:`${input.packageRoot}/app/runtime.ts`,
  };
}

export function renderLaunchAgent(input:LaunchAgentInput):string{
  const paths=launchAgentPaths(input);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    ownershipComment,
    '<plist version="1.0">',
    '<dict>',
    '<key>Label</key>',
    xmlText(paths.label),
    '<key>ProgramArguments</key>',
    '<array>',
    xmlText(input.bunPath),
    xmlText(paths.runtimePath),
    '</array>',
    '<key>WorkingDirectory</key>',
    xmlText(input.packageRoot),
    '<key>EnvironmentVariables</key>',
    '<dict>',
    '<key>STREAMHUB_CONFIG</key>',
    xmlText(paths.configPath),
    '</dict>',
    '<key>StandardOutPath</key>',
    xmlText(paths.logPath),
    '<key>StandardErrorPath</key>',
    xmlText(paths.logPath),
    '<key>RunAtLoad</key>',
    '<true/>',
    '<key>KeepAlive</key>',
    '<dict>',
    '<key>SuccessfulExit</key>',
    '<false/>',
    '</dict>',
    '<key>ThrottleInterval</key>',
    '<integer>10</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function matchingValues(xml:string,key:string,element:string):string[]{
  const expression=new RegExp(`<key>${key}</key>\\s*<${element}>([^<]*)</${element}>`,'g');
  return [...xml.matchAll(expression)].map(match=>match[1]);
}

function requireExactValue(xml:string,key:string,element:string,expected:string,description:string):void{
  const values=matchingValues(xml,key,element);
  if(values.length!==1||values[0]!==xmlEscape(expected)){
    throw new Error(`Invalid owned LaunchAgent: ${description}`);
  }
}

function requireBoolean(xml:string,key:string,value:boolean,description:string):void{
  const element=value?'true':'false';
  const expression=new RegExp(`<key>${key}</key>\\s*<${element}\\s*/>`,'g');
  if([...xml.matchAll(expression)].length!==1){
    throw new Error(`Invalid owned LaunchAgent: ${description}`);
  }
}

function requireProgramArguments(xml:string,bunPath:string,runtimePath:string):void{
  const matches=[...xml.matchAll(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/g)];
  if(matches.length!==1) throw new Error('Invalid owned LaunchAgent: ProgramArguments');
  const content=matches[0]![1];
  const argumentsFound=[...content.matchAll(/<string>([^<]*)<\/string>/g)].map(match=>match[1]);
  const remainder=content.replace(/<string>([^<]*)<\/string>/g,'').trim();
  if(remainder!==''||argumentsFound.length!==2){
    throw new Error('Invalid owned LaunchAgent: ProgramArguments');
  }
  if(argumentsFound[0]!==xmlEscape(bunPath)){
    throw new Error('Invalid owned LaunchAgent: Bun path');
  }
  if(argumentsFound[1]!==xmlEscape(runtimePath)){
    throw new Error('Invalid owned LaunchAgent: runtime path');
  }
}

function requireConfigPath(xml:string,configPath:string):void{
  const matches=[...xml.matchAll(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)];
  if(matches.length!==1) throw new Error('Invalid owned LaunchAgent: STREAMHUB_CONFIG');
  const values=matchingValues(matches[0]![1],'STREAMHUB_CONFIG','string');
  if(values.length!==1||values[0]!==xmlEscape(configPath)){
    throw new Error('Invalid owned LaunchAgent: STREAMHUB_CONFIG path');
  }
}

export function validateOwnedLaunchAgent(xml:string,expected:LaunchAgentInput):void{
  validateInput(expected);
  const paths=launchAgentPaths(expected);
  if(!xml.includes(ownershipComment)) throw new Error('Invalid owned LaunchAgent: ownership marker');
  requireExactValue(xml,'Label','string',runtimeLabel,'label');
  requireProgramArguments(xml,expected.bunPath,paths.runtimePath);
  requireExactValue(xml,'WorkingDirectory','string',expected.packageRoot,'working directory path');
  requireConfigPath(xml,paths.configPath);
  requireExactValue(xml,'StandardOutPath','string',paths.logPath,'standard output path');
  requireExactValue(xml,'StandardErrorPath','string',paths.logPath,'standard error path');
  requireBoolean(xml,'RunAtLoad',true,'RunAtLoad');
  requireBoolean(xml,'SuccessfulExit',false,'KeepAlive.SuccessfulExit');
  requireExactValue(xml,'ThrottleInterval','integer','10','ThrottleInterval');
}

function firstInteger(output:string,field:string):number|undefined{
  const expression=new RegExp(`^${field}\\s*=\\s*(-?\\d+)\\s*$`,'gm');
  for(const match of output.matchAll(expression)){
    const value=Number(match[1]);
    if(Number.isSafeInteger(value)) return value;
  }
  return undefined;
}

export function parseLaunchctlPrint(output:string):LaunchctlState{
  const state:LaunchctlState={loaded:true,running:/^state\s*=\s*running\s*$/m.test(output)};
  const pid=firstInteger(output,'pid');
  if(pid!==undefined&&pid>0) state.pid=pid;
  const lastExitStatus=firstInteger(output,'last exit code');
  if(lastExitStatus!==undefined&&lastExitStatus>=-2147483648&&lastExitStatus<=2147483647){
    state.lastExitStatus=lastExitStatus;
  }
  return state;
}
