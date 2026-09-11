import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Config} from '../host/src/config';
import {setupDisplayMode} from './setup';

const baseConfig=():Config=>({port:31415,adminToken:'a'.repeat(64),sources:{demo:{token:'b'.repeat(64)}},display:{mode:'off',plugin:{port:31417,tokenFile:'/existing/token'}}});
const writePlugin=(directory:string,version='0.2.0.0')=>{mkdirSync(join(directory,'bin'),{recursive:true});writeFileSync(join(directory,'manifest.json'),JSON.stringify({UUID:'com.streamhub.studio',Version:version,CodePath:'bin/plugin.js'}));writeFileSync(join(directory,'bin/plugin.js'),`plugin-${version}`);mkdirSync(join(directory,'logs'));writeFileSync(join(directory,'logs/private.log'),'do not package');};
const fixture=(mode:'hid'|'plugin')=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-release-setup-')),packageRoot=join(root,'package'),applicationSupport=join(root,'Application Support'),source=join(packageRoot,'share/streamdeck-plugin/com.streamhub.studio.sdPlugin');
  writePlugin(source);let config=baseConfig();
  return{root,packageRoot,applicationSupport,source,options:{mode,packageRoot,applicationSupport,now:()=>new Date('2026-09-11T01:02:03.000Z'),update:((mutate:(current:Config)=>Config)=>config=mutate(structuredClone(config)))},config:()=>config};
};

test('HID setup changes only the canonical mode',async()=>{
  const h=fixture('hid'),before=h.config();const result=await setupDisplayMode(h.options);
  expect(h.config()).toEqual({...before,display:{...before.display,mode:'hid'}});
  expect(result).toEqual({mode:'hid',guidance:'Stream Deck 앱을 완전히 종료한 뒤 streamhub start를 실행하세요.'});
});

test('plugin setup installs a clean bundle, private connection, and backs up a different owned bundle',async()=>{
  const h=fixture('plugin'),target=join(h.applicationSupport,'com.elgato.StreamDeck','Plugins','com.streamhub.studio.sdPlugin');writePlugin(target,'0.1.0.0');
  const result=await setupDisplayMode(h.options),backup=`${target}.20260911T010203Z.backup`,token=join(h.applicationSupport,'Streamhub','plugin','token');
  expect(result.backupPath).toBe(backup);expect(readFileSync(join(backup,'bin/plugin.js'),'utf8')).toBe('plugin-0.1.0.0');
  expect(readFileSync(join(target,'bin/plugin.js'),'utf8')).toBe('plugin-0.2.0.0');expect(Bun.file(join(target,'logs/private.log')).size).toBe(0);
  expect(statSync(token).mode&0o777).toBe(0o600);expect(JSON.parse(readFileSync(join(h.applicationSupport,'Streamhub','plugin','connection.json'),'utf8'))).toEqual({url:'ws://127.0.0.1:31417',tokenFile:token});
  expect(h.config().display).toEqual({mode:'plugin',plugin:{port:31417,tokenFile:token}});
});

test('identical plugin setup is repeatable without another backup',async()=>{
  const h=fixture('plugin');await setupDisplayMode(h.options);const second=await setupDisplayMode(h.options);
  expect(second.backupPath).toBeUndefined();expect(h.config().display.mode).toBe('plugin');
});

test('plugin setup rejects missing bundles, linked targets, and invalid private tokens',async()=>{
  const missing=fixture('plugin');expect(setupDisplayMode({...missing.options,packageRoot:join(missing.root,'absent')})).rejects.toThrow('bundle');
  const linked=fixture('plugin'),outside=join(linked.root,'outside');writePlugin(outside);const target=join(linked.applicationSupport,'com.elgato.StreamDeck','Plugins','com.streamhub.studio.sdPlugin');mkdirSync(join(target,'..'),{recursive:true});symlinkSync(outside,target);
  expect(setupDisplayMode(linked.options)).rejects.toThrow('symbolic link');
  const token=fixture('plugin'),pluginDirectory=join(token.applicationSupport,'Streamhub','plugin');mkdirSync(pluginDirectory,{recursive:true});writeFileSync(join(pluginDirectory,'token'),'short\n');
  expect(setupDisplayMode(token.options)).rejects.toThrow('token');
});
