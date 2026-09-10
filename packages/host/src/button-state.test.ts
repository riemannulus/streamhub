import {expect,test} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileButtonStateStore,buttonStateKey} from './button-state';

const key={documentId:'11111111-1111-4111-8111-111111111111',pageId:'home',buttonId:'power'};
const temporary=()=>mkdtempSync(join(tmpdir(),'streamhub-button-state-'));

test('missing state starts empty and updates survive restart in serialized order',async()=>{
  const directory=temporary();try{const store=new FileButtonStateStore(directory);expect(store.getToggle(key)).toBeUndefined();const first=store.setToggle(key,'on'),second=store.setToggle(key,'off');await Promise.all([first,second]);expect(new FileButtonStateStore(directory).getToggle(key)).toBe('off');expect(JSON.parse(readFileSync(join(directory,'button-state.json'),'utf8')).values[buttonStateKey(key)]).toBe('off');}finally{rmSync(directory,{recursive:true,force:true});}
});

test('invalid files are quarantined and document namespaces do not collide',async()=>{
  const directory=temporary();try{mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'button-state.json'),'{broken');const store=new FileButtonStateStore(directory);expect(store.getToggle(key)).toBeUndefined();expect(readdirSync(directory).some(name=>name.startsWith('button-state.invalid.'))).toBe(true);const other={...key,documentId:'22222222-2222-4222-8222-222222222222'};await store.setToggle(key,'on');expect(store.getToggle(other)).toBeUndefined();await store.setToggle(other,'off');expect(store.getToggle(key)).toBe('on');}finally{rmSync(directory,{recursive:true,force:true});}
});

test('prunes deleted buttons, rejects path-like IDs and caps state',async()=>{
  const directory=temporary();try{const store=new FileButtonStateStore(directory);await store.setToggle(key,'on');const keep={...key,buttonId:'keep'};await store.setToggle(keep,'off');await store.prune(new Set([buttonStateKey(keep)]));expect(store.getToggle(key)).toBeUndefined();expect(store.getToggle(keep)).toBe('off');await expect(store.setToggle({...key,pageId:'../escape'},'on')).rejects.toThrow('ID');expect(existsSync(join(directory,'button-state.json.tmp'))).toBe(false);
    const values=Object.fromEntries(Array.from({length:4096},(_,index)=>[buttonStateKey({...key,buttonId:`button-${index}`}),index%2?'on':'off']));writeFileSync(join(directory,'button-state.json'),JSON.stringify({version:1,values}));const full=new FileButtonStateStore(directory);await expect(full.setToggle({...key,buttonId:'overflow'},'on')).rejects.toThrow('limit');
  }finally{rmSync(directory,{recursive:true,force:true});}
});
