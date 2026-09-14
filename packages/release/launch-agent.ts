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

const managedPathObjects=new WeakSet<LaunchAgentPaths>();

export type LaunchctlState={
  loaded:boolean;
  running:boolean;
  pid?:number;
  lastExitStatus?:number;
};

const ownershipComment='<!-- Managed by Streamhub Preview -->';
const xmlDeclaration='<?xml version="1.0" encoding="UTF-8"?>';
const plistDoctype='<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';

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
  const paths=Object.freeze({
    label:runtimeLabel,
    domain,
    service:`${domain}/${runtimeLabel}`,
    plistPath:underHome(input.home,`Library/LaunchAgents/${runtimeLabel}.plist`),
    configPath:`${dataPath}/config.json`,
    logPath:`${dataPath}/logs/runtime.log`,
    previousLogPath:`${dataPath}/logs/runtime.log.1`,
    runtimePath:`${input.packageRoot}/app/runtime.ts`,
  });
  managedPathObjects.add(paths);
  return paths;
}

function normalizedAbsolutePath(path:string):boolean{
  return path.startsWith('/')&&!path.includes('\0')&&path.split('/').every((segment,index)=>index===0||Boolean(segment)&&segment!=='.'&&segment!=='..');
}

export function isManagedLaunchAgentPaths(value:unknown):value is LaunchAgentPaths{
  if(typeof value!=='object'||value===null) return false;
  const paths=value as LaunchAgentPaths;
  if(!Object.isFrozen(paths)||!managedPathObjects.has(paths)) return false;
  const domain=paths.domain.match(/^gui\/([1-9]\d*)$/);
  const plistSuffix=`/Library/LaunchAgents/${runtimeLabel}.plist`;
  if(!domain||!Number.isSafeInteger(Number(domain[1]))||!paths.plistPath.endsWith(plistSuffix)) return false;
  const home=paths.plistPath.slice(0,-plistSuffix.length);
  const dataPath=`${home}/Library/Application Support/Streamhub/data`;
  const runtimeSuffix='/app/runtime.ts';
  const packageRoot=paths.runtimePath.endsWith(runtimeSuffix)?paths.runtimePath.slice(0,-runtimeSuffix.length):'';
  const applicationRoot=packageRoot.match(/^(.*\/Streamhub)\/app\/[^/]+$/)?.[1];
  if(!applicationRoot) return false;
  return paths.label===runtimeLabel&&paths.service===`${paths.domain}/${runtimeLabel}`&&
    paths.configPath===`${dataPath}/config.json`&&paths.logPath===`${dataPath}/logs/runtime.log`&&
    paths.previousLogPath===`${dataPath}/logs/runtime.log.1`&&
    [paths.plistPath,paths.configPath,paths.logPath,paths.previousLogPath,paths.runtimePath,packageRoot,applicationRoot].every(normalizedAbsolutePath);
}

export function renderLaunchAgent(input:LaunchAgentInput):string{
  const paths=launchAgentPaths(input);
  return [
    xmlDeclaration,
    plistDoctype,
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

type XmlText={kind:'text';value:string};
type XmlComment={kind:'comment';value:string};
type XmlElement={kind:'element';name:string;attributes:string;children:XmlNode[]};
type XmlNode=XmlText|XmlComment|XmlElement;

class PlistParser{
  private index=0;
  readonly comments:string[]=[];

  constructor(private readonly xml:string){}

  parse():XmlElement{
    this.skipWhitespace();
    if(this.startsWith('<?xml')){
      if(!this.startsWith(xmlDeclaration)) throw new Error('invalid XML declaration');
      this.index+=xmlDeclaration.length;
    }
    this.skipWhitespaceAndComments();
    if(this.startsWith(plistDoctype)) this.index+=plistDoctype.length;
    this.skipWhitespaceAndComments();
    const root=this.parseElement();
    this.skipWhitespaceAndComments();
    if(this.index!==this.xml.length) throw new Error('trailing content');
    return root;
  }

  private parseElement():XmlElement{
    const match=this.xml.slice(this.index).match(/^<([A-Za-z_][A-Za-z0-9_.:-]*)([^<>]*)>/);
    if(!match) throw new Error('invalid element');
    this.index+=match[0].length;
    const rawAttributes=match[2]!;
    const selfClosing=rawAttributes.endsWith('/');
    const attributes=(selfClosing?rawAttributes.slice(0,-1):rawAttributes).trim();
    const element:XmlElement={kind:'element',name:match[1]!,attributes,children:[]};
    if(selfClosing) return element;

    while(true){
      if(this.startsWith(`</${element.name}>`)){
        this.index+=element.name.length+3;
        return element;
      }
      if(this.startsWith('</')) throw new Error('mismatched closing tag');
      if(this.startsWith('<!--')){
        element.children.push(this.consumeComment());
        continue;
      }
      if(this.startsWith('<![CDATA[')||this.startsWith('<!')||this.startsWith('<?')){
        throw new Error('unsupported XML construct');
      }
      if(this.startsWith('<')){
        element.children.push(this.parseElement());
        continue;
      }
      const nextTag=this.xml.indexOf('<',this.index);
      if(nextTag===-1) throw new Error('unclosed element');
      const value=this.xml.slice(this.index,nextTag);
      this.assertWellFormedText(value);
      this.index=nextTag;
      if(value) element.children.push({kind:'text',value});
    }
  }

  private skipWhitespaceAndComments():void{
    while(true){
      this.skipWhitespace();
      if(!this.startsWith('<!--')) return;
      this.consumeComment();
    }
  }

  private consumeComment():XmlComment{
    const end=this.xml.indexOf('-->',this.index+4);
    if(end===-1) throw new Error('unclosed comment');
    const value=this.xml.slice(this.index+4,end);
    if(value.includes('--')) throw new Error('invalid comment');
    this.index=end+3;
    this.comments.push(value);
    return {kind:'comment',value};
  }

  private assertWellFormedText(value:string):void{
    const remaining=value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g,'');
    if(remaining.includes('&')) throw new Error('unescaped entity');
  }

  private skipWhitespace():void{
    while(this.index<this.xml.length&&/\s/.test(this.xml[this.index]!)) this.index++;
  }

  private startsWith(value:string):boolean{
    return this.xml.startsWith(value,this.index);
  }
}

function invalidOwned(description:string):never{
  throw new Error(`Invalid owned LaunchAgent: ${description}`);
}

function elementChildren(element:XmlElement,description:string):XmlElement[]{
  const children:XmlElement[]=[];
  for(const child of element.children){
    if(child.kind==='text'&&child.value.trim()==='') continue;
    if(child.kind!=='element') invalidOwned(description);
    children.push(child);
  }
  return children;
}

function textValue(element:XmlElement,name:string,description:string):string{
  if(element.name!==name||element.attributes) invalidOwned(description);
  let value='';
  for(const child of element.children){
    if(child.kind!=='text') invalidOwned(description);
    value+=child.value;
  }
  return value;
}

function stringValue(element:XmlElement,description:string):string{
  return textValue(element,'string',description);
}

function dictionaryEntries(element:XmlElement,description:string):Map<string,XmlElement>{
  if(element.name!=='dict'||element.attributes) invalidOwned(description);
  const children=elementChildren(element,description);
  if(children.length%2!==0) invalidOwned(description);
  const entries=new Map<string,XmlElement>();
  for(let index=0;index<children.length;index+=2){
    const key=textValue(children[index]!,'key','plist structure');
    if(entries.has(key)) invalidOwned(description);
    entries.set(key,children[index+1]!);
  }
  return entries;
}

function requireEntry(entries:Map<string,XmlElement>,key:string,description:string):XmlElement{
  return entries.get(key)??invalidOwned(description);
}

function requireExactString(entries:Map<string,XmlElement>,key:string,expected:string,description:string):void{
  if(stringValue(requireEntry(entries,key,description),description)!==xmlEscape(expected)) invalidOwned(description);
}

function requireBooleanElement(element:XmlElement,value:boolean,description:string):void{
  if(element.name!==(value?'true':'false')||element.attributes||elementChildren(element,description).length!==0){
    invalidOwned(description);
  }
}

function requireProgramArguments(entries:Map<string,XmlElement>,bunPath:string,runtimePath:string):void{
  const array=requireEntry(entries,'ProgramArguments','ProgramArguments');
  if(array.name!=='array'||array.attributes) invalidOwned('ProgramArguments');
  const argumentsFound=elementChildren(array,'ProgramArguments');
  if(argumentsFound.length!==2) invalidOwned('ProgramArguments');
  if(stringValue(argumentsFound[0]!,'Bun path')!==xmlEscape(bunPath)) invalidOwned('Bun path');
  if(stringValue(argumentsFound[1]!,'runtime path')!==xmlEscape(runtimePath)) invalidOwned('runtime path');
}

function parseOwnedPlist(xml:string):{entries:Map<string,XmlElement>;owned:boolean}{
  try{
    const parser=new PlistParser(xml);
    const root=parser.parse();
    if(root.name!=='plist'||root.attributes!=='version="1.0"') invalidOwned('plist structure');
    const children=elementChildren(root,'plist structure');
    if(children.length!==1) invalidOwned('plist structure');
    return {entries:dictionaryEntries(children[0]!,'plist structure'),owned:parser.comments.includes(' Managed by Streamhub Preview ')};
  }catch(error){
    if(error instanceof Error&&error.message.startsWith('Invalid owned LaunchAgent:')) throw error;
    invalidOwned('plist structure');
  }
}

export function validateOwnedLaunchAgent(xml:string,expected:LaunchAgentInput):void{
  validateInput(expected);
  const paths=launchAgentPaths(expected);
  const plist=parseOwnedPlist(xml);
  if(!plist.owned) invalidOwned('ownership marker');
  const expectedKeys=['Label','ProgramArguments','WorkingDirectory','EnvironmentVariables','StandardOutPath','StandardErrorPath','RunAtLoad','KeepAlive','ThrottleInterval'];
  if(expectedKeys.some(key=>!plist.entries.has(key))) invalidOwned('plist structure');
  requireExactString(plist.entries,'Label',runtimeLabel,'label');
  requireProgramArguments(plist.entries,expected.bunPath,paths.runtimePath);
  requireExactString(plist.entries,'WorkingDirectory',expected.packageRoot,'working directory path');
  const environment=dictionaryEntries(requireEntry(plist.entries,'EnvironmentVariables','STREAMHUB_CONFIG'),'STREAMHUB_CONFIG');
  if(environment.size!==1) invalidOwned('STREAMHUB_CONFIG');
  requireExactString(environment,'STREAMHUB_CONFIG',paths.configPath,'STREAMHUB_CONFIG path');
  requireExactString(plist.entries,'StandardOutPath',paths.logPath,'standard output path');
  requireExactString(plist.entries,'StandardErrorPath',paths.logPath,'standard error path');
  requireBooleanElement(requireEntry(plist.entries,'RunAtLoad','RunAtLoad'),true,'RunAtLoad');
  const keepAlive=dictionaryEntries(requireEntry(plist.entries,'KeepAlive','KeepAlive'),'KeepAlive');
  if(keepAlive.size!==1) invalidOwned('KeepAlive');
  requireBooleanElement(requireEntry(keepAlive,'SuccessfulExit','KeepAlive.SuccessfulExit'),false,'KeepAlive.SuccessfulExit');
  const throttle=requireEntry(plist.entries,'ThrottleInterval','ThrottleInterval');
  if(textValue(throttle,'integer','ThrottleInterval')!=='10'){
    invalidOwned('ThrottleInterval');
  }
  if(plist.entries.size!==expectedKeys.length) invalidOwned('plist structure');
}

function firstInteger(output:string,field:string):number|undefined{
  const expression=new RegExp(`^[\\t ]*${field}\\s*=\\s*(-?\\d+)\\s*$`,'gm');
  for(const match of output.matchAll(expression)){
    const value=Number(match[1]);
    if(Number.isSafeInteger(value)) return value;
  }
  return undefined;
}

export function parseLaunchctlPrint(output:string):LaunchctlState{
  const state:LaunchctlState={loaded:true,running:/^[\t ]*state\s*=\s*running\s*$/m.test(output)};
  const pid=firstInteger(output,'pid');
  if(pid!==undefined&&pid>0) state.pid=pid;
  const lastExitStatus=firstInteger(output,'last exit code');
  if(lastExitStatus!==undefined&&lastExitStatus>=-2147483648&&lastExitStatus<=2147483647){
    state.lastExitStatus=lastExitStatus;
  }
  return state;
}
