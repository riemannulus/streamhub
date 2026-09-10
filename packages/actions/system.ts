import {chmodSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {ActionRegistry,type ActionDefinition,type ActionPress} from '../host/src/actions';
import {validateButtonAction as validateStudioButtonAction,type ButtonAction} from '../studio/document';
export {KEY_CODES,MEDIA_COMMANDS} from '../studio/document';

const LOCAL_SOURCE='__deck__';
type NativeAction=Extract<ButtonAction,{type:'hotkey'|'text'|'media'}>;
export type ProcessRequest={argv:string[];input?:string;cwd?:string;timeoutMs:number;maxOutputBytes:number};
export type ProcessResult={stdout:string;stderr:string;exitCode:number};
export type NativeResult={ok:boolean;error?:'accessibility-permission-required'|'media-unsupported'|'native-action-failed'};
export type SystemActionDependencies={
  runProcess?:(request:ProcessRequest,signal?:AbortSignal)=>Promise<ProcessResult>;
  runNative?:(action:NativeAction,signal?:AbortSignal)=>Promise<NativeResult>;
  runRegistered?:(registry:ActionRegistry,press:ActionPress,signal?:AbortSignal)=>Promise<unknown>;
  cacheDir?:string;
};

export class SystemActionError extends Error{
  constructor(public readonly code:'cancelled'|'timeout'|'output-limit'|'process-failed'|'accessibility-permission-required'|'media-unsupported'|'native-action-failed',message:string=code){super(message);this.name='SystemActionError';}
}

const stopped=(signal?:AbortSignal)=>{if(signal?.aborted)throw new SystemActionError('cancelled','System action cancelled');};

export async function runBoundedProcess(request:ProcessRequest,signal?:AbortSignal):Promise<ProcessResult>{
  stopped(signal);
  if(!request.argv.length||!request.argv.every(value=>typeof value==='string'&&!value.includes('\0')))throw new Error('Invalid process argv');
  if(!Number.isInteger(request.timeoutMs)||request.timeoutMs<1||request.timeoutMs>60000)throw new Error('Invalid process timeout');
  if(!Number.isInteger(request.maxOutputBytes)||request.maxOutputBytes<1||request.maxOutputBytes>1048576)throw new Error('Invalid process output limit');
  const process=Bun.spawn(request.argv,{cwd:request.cwd??processCwd(),env:{PATH:globalThis.process.env.PATH??'/usr/bin:/bin'},stdin:request.input===undefined?'ignore':'pipe',stdout:'pipe',stderr:'pipe',detached:globalThis.process.platform!=='win32'});
  if(request.input!==undefined){process.stdin!.write(request.input);process.stdin!.end();}
  const kill=()=>{try{if(globalThis.process.platform!=='win32')globalThis.process.kill(-process.pid,'SIGKILL');else process.kill('SIGKILL');}catch{/* already exited */}};
  const abort=()=>kill();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)kill();
  let timedOut=false,total=0,limited=false;
  const timer=setTimeout(()=>{timedOut=true;kill();},request.timeoutMs);
  const read=async(stream:ReadableStream<Uint8Array>)=>{const chunks:Uint8Array[]=[];for await(const chunk of stream){total+=chunk.byteLength;if(total>request.maxOutputBytes){limited=true;kill();break;}chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');};
  try{
    const [stdout,stderr,exitCode]=await Promise.all([read(process.stdout),read(process.stderr),process.exited]);
    if(signal?.aborted)throw new SystemActionError('cancelled','System action cancelled');
    if(limited)throw new SystemActionError('output-limit','System action output limit exceeded');
    if(timedOut)throw new SystemActionError('timeout','System action timed out');
    if(exitCode!==0)throw new SystemActionError('process-failed',`System action failed with exit ${exitCode}${stderr?`: ${stderr.slice(0,1024)}`:''}`);
    return{stdout,stderr,exitCode};
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);kill();await process.exited;}
}

function processCwd(){return globalThis.process.cwd();}
const trusted=(actions:Record<string,ActionDefinition>)=>Object.fromEntries(Object.entries(actions).map(([name,definition])=>[name,{...definition,sources:[LOCAL_SOURCE]}]));

const SWIFT_SOURCE=String.raw`import ApplicationServices
import AppKit
import Foundation

struct Request: Decodable { let type: String; let keys: [String]?; let text: String?; let mode: String?; let command: String? }
struct Result: Encodable { let ok: Bool; let error: String? }

func finish(_ result: Result, _ code: Int32 = 0) -> Never {
  let data = try! JSONEncoder().encode(result)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([10]))
  exit(code)
}

let keyCodes: [String: CGKeyCode] = [
  "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,
  "1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"right":124,"left":123,"down":125,"up":126,
  "o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46,"enter":36,"tab":48,"space":49,"escape":53,
  "f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111
]
let modifiers: [String: CGEventFlags] = ["command":.maskCommand,"option":.maskAlternate,"control":.maskControl,"shift":.maskShift]

guard let line = readLine(), let data = line.data(using:.utf8), let request = try? JSONDecoder().decode(Request.self, from:data) else { finish(Result(ok:false,error:"native-action-failed")) }

if request.type == "media" {
  let codes=["play-pause":16,"previous-track":20,"next-track":19,"volume-up":0,"volume-down":1,"mute-toggle":7]
  guard let key=codes[request.command ?? ""] else { finish(Result(ok:false,error:"media-unsupported")) }
  for down in [true,false] {
    let flags=down ? 0xA00 : 0xB00
    guard let event=NSEvent.otherEvent(with:.systemDefined,location:.zero,modifierFlags:[],timestamp:0,windowNumber:0,context:nil,subtype:8,data1:(key << 16) | (flags << 8),data2:-1)?.cgEvent else { finish(Result(ok:false,error:"media-unsupported")) }
    event.post(tap:.cghidEventTap)
  }
  finish(Result(ok:true,error:nil))
}

guard AXIsProcessTrusted() else { finish(Result(ok:false,error:"accessibility-permission-required")) }
if request.type == "hotkey" {
  let keys=request.keys ?? [], flags=keys.compactMap { modifiers[$0] }.reduce(CGEventFlags()) { $0.union($1) }
  guard let keyName=keys.last(where:{ keyCodes[$0] != nil }), let code=keyCodes[keyName] else { finish(Result(ok:false,error:"native-action-failed")) }
  for down in [true,false] { guard let event=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:down) else { finish(Result(ok:false,error:"native-action-failed")) };event.flags=flags;event.post(tap:.cghidEventTap) }
  finish(Result(ok:true,error:nil))
}
if request.type == "text", let text=request.text {
  if request.mode == "paste" {
    NSPasteboard.general.clearContents();NSPasteboard.general.setString(text,forType:.string)
    for down in [true,false] { guard let event=CGEvent(keyboardEventSource:nil,virtualKey:9,keyDown:down) else { finish(Result(ok:false,error:"native-action-failed")) };event.flags = .maskCommand;event.post(tap:.cghidEventTap) }
  } else {
    let units=Array(text.utf16);guard let down=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true),let up=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false) else { finish(Result(ok:false,error:"native-action-failed")) }
    units.withUnsafeBufferPointer { pointer in down.keyboardSetUnicodeString(stringLength:units.count,unicodeString:pointer.baseAddress);up.keyboardSetUnicodeString(stringLength:units.count,unicodeString:pointer.baseAddress) };down.post(tap:.cghidEventTap);up.post(tap:.cghidEventTap)
  }
  finish(Result(ok:true,error:nil))
}
finish(Result(ok:false,error:"native-action-failed"))`;

class NativeSystemHelper{
  private binaryPromise?:Promise<string>;
  constructor(private readonly cacheDir:string,private readonly runProcess:(request:ProcessRequest,signal?:AbortSignal)=>Promise<ProcessResult>){}
  ensure(signal?:AbortSignal):Promise<string>{
    return this.binaryPromise??=(async()=>{
      const hash=createHash('sha256').update(SWIFT_SOURCE).digest('hex'),directory=join(this.cacheDir,hash),source=join(directory,`${hash}.swift`),binary=join(directory,hash);
      if(existsSync(binary))return binary;
      mkdirSync(directory,{recursive:true});writeFileSync(source,SWIFT_SOURCE,{encoding:'utf8',mode:0o600});
      await this.runProcess({argv:['/usr/bin/swiftc','-O',source,'-o',binary],timeoutMs:60000,maxOutputBytes:65536},signal);chmodSync(binary,0o700);return binary;
    })().catch(error=>{this.binaryPromise=undefined;throw error;});
  }
  async run(action:NativeAction,signal?:AbortSignal):Promise<NativeResult>{
    const binary=await this.ensure(signal),result=await this.runProcess({argv:[binary],input:`${JSON.stringify(action)}\n`,timeoutMs:3000,maxOutputBytes:4096},signal);
    try{const parsed=JSON.parse(result.stdout) as NativeResult;if(typeof parsed.ok!=='boolean')throw new Error();return parsed;}catch{throw new SystemActionError('native-action-failed','Invalid native action response');}
  }
}

export class SystemActionCatalog{
  private readonly registry:ActionRegistry;
  private readonly process:(request:ProcessRequest,signal?:AbortSignal)=>Promise<ProcessResult>;
  private readonly native:(action:NativeAction,signal?:AbortSignal)=>Promise<NativeResult>;
  private readonly registered:(registry:ActionRegistry,press:ActionPress,signal?:AbortSignal)=>Promise<unknown>;
  constructor(private readonly actions:Record<string,ActionDefinition>={},dependencies:SystemActionDependencies={}){
    this.registry=new ActionRegistry(trusted(actions));this.process=dependencies.runProcess??runBoundedProcess;
    const helper=new NativeSystemHelper(dependencies.cacheDir??join(processCwd(),'.streamhub/native/system-actions'),this.process);
    this.native=dependencies.runNative??((action,signal)=>helper.run(action,signal));
    this.registered=dependencies.runRegistered??((registry,press,signal)=>registry.run(LOCAL_SOURCE,press,signal));
  }
  entries(){return Object.entries(this.actions).map(([name,definition])=>({name,args:Object.keys(definition.args)}));}
  validateButtonAction(action:ButtonAction):ButtonAction{
    const validated=validateStudioButtonAction(action,{actions:Object.fromEntries(Object.entries(this.actions).map(([name,definition])=>[name,{args:Object.fromEntries(Object.keys(definition.args).map(key=>[key,{}]))}]))});
    if(validated.type==='hotkey'){
      const modifiers=new Set(['command','option','control','shift']),nonModifiers=validated.keys.filter(key=>!modifiers.has(key));
      if(nonModifiers.length!==1||modifiers.has(validated.keys.at(-1)!))throw new Error('Invalid hotkey order');
    }
    if(validated.type==='registered')this.registry.validate(LOCAL_SOURCE,{type:'action',name:validated.name,args:validated.args});
    return validated;
  }
  async executeButtonAction(action:ButtonAction,signal?:AbortSignal):Promise<void>{
    stopped(signal);const validated=this.validateButtonAction(action);
    if(validated.type==='none'||validated.type==='go-to-page'||validated.type==='previous-page'||validated.type==='next-page'||validated.type==='page-indicator'||validated.type==='resume-auto-page')return;
    if(validated.type==='registered'){const press:ActionPress={type:'action',name:validated.name,args:validated.args};await this.registered(this.registry,press,signal);return;}
    if(validated.type==='open-app'){await this.process({argv:['/usr/bin/open','-b',validated.bundleId],timeoutMs:3000,maxOutputBytes:4096},signal);return;}
    if(validated.type==='open-path'){await this.process({argv:['/usr/bin/open',validated.path],timeoutMs:3000,maxOutputBytes:4096},signal);return;}
    if(validated.type==='open-url'){await this.process({argv:['/usr/bin/open',...(validated.browserBundleId?['-b',validated.browserBundleId]:[]),validated.url],timeoutMs:3000,maxOutputBytes:4096},signal);return;}
    const result=await this.native(validated,signal);if(!result.ok)throw new SystemActionError(result.error??'native-action-failed');
  }
}

export function validateButtonAction(action:ButtonAction,actions:Record<string,ActionDefinition>={}):ButtonAction{return new SystemActionCatalog(actions).validateButtonAction(action);}
export function executeButtonAction(action:ButtonAction,signal?:AbortSignal,dependencies:SystemActionDependencies={}):Promise<void>{return new SystemActionCatalog({},dependencies).executeButtonAction(action,signal);}
export function compileNativeSystemActionHelper(cacheDir:string,signal?:AbortSignal):Promise<string>{return new NativeSystemHelper(cacheDir,runBoundedProcess).ensure(signal);}
