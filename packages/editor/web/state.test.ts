import {expect,test} from 'bun:test';
import {filteredActions} from './action-library';
import {inspectorFor} from './inspector-view';
import type {ButtonAction,ButtonDefinition} from '../../studio/document';
import {defaultStudioDocument,singlePressBehavior,validateStudioDocument} from '../../studio/document';
import {createButtonForAction} from './action-library';
import {StudioState} from './state';

const appearance={contentMode:'hidden' as const};
test('action search matches Korean labels and stable action types across groups',()=>{
  expect(filteredActions('페이지')).toEqual(expect.arrayContaining(['go-to-page','previous-page','next-page','page-indicator']));
  expect(filteredActions('open-url')).toEqual(['open-url']);
  expect(filteredActions('미디어')).toContain('media');
  expect(filteredActions('동적')).toEqual(expect.arrayContaining(['dynamic-region','dynamic-previous','dynamic-next']));
});

test('inspector fields depend on action while appearance fields stay explicit',()=>{
  const openAppButton:ButtonDefinition={id:'app',index:0,behavior:singlePressBehavior({type:'open-app',bundleId:'org.mozilla.firefox'}),appearance};
  const pageIndicatorButton:ButtonDefinition={id:'indicator',index:1,behavior:singlePressBehavior({type:'page-indicator'}),appearance};
  expect(inspectorFor(openAppButton)).toEqual(['action','content-mode','icon','label','background']);
  expect(inspectorFor(pageIndicatorButton)).toEqual(['content-mode','icon','label','background']);
  expect(inspectorFor(undefined)).toEqual(['empty']);
});

test('every available core library action creates a valid v3 button',()=>{
  const types=filteredActions('').filter(type=>!type.startsWith('dynamic-')&&!['multi-action','toggle-action','double-press','hold-action'].includes(type)) as ButtonAction['type'][];
  for(const [index,type] of types.entries()){
    const document=defaultStudioDocument();document.pages[0].buttons=[createButtonForAction(type,index,{pageId:'home',appBundleId:'org.mozilla.firefox',registered:[{name:'build',args:['target']} ]})];
    expect(()=>validateStudioDocument(document,{actions:{build:{args:{target:{}}}}})).not.toThrow();
  }
});

test('each successful change queues exactly one draft save',async()=>{
  const calls:string[]=[],document=defaultStudioDocument();
  const request=async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input);calls.push(`${init?.method??'GET'} ${url}`);if(url==='/api/bootstrap')return Response.json({token:'t',snapshot:{document,version:'v1'},runtimeStatus:{connected:false},geometry:{x:[11,108,205,302,399],y:[5,102,199]}});if(url.includes('/catalog/'))return Response.json([]);return Response.json({document});};
  const state=await StudioState.connect(request as typeof fetch);state.model.setSurfaceColor('page','#111111');state.changed();state.model.setSurfaceColor('page','#222222');state.changed();
  for(let attempt=0;attempt<10&&calls.filter(call=>call==='POST /api/draft').length<2;attempt++)await Bun.sleep(0);
  expect(calls.filter(call=>call==='POST /api/draft')).toHaveLength(2);
});

test('icon library loads packs lazily, searches one pack and imports the selected icon',async()=>{
  const calls:{url:string;init?:RequestInit}[]=[],document=defaultStudioDocument(),packId='a'.repeat(64),iconId='b'.repeat(64);
  const request=async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input);calls.push({url,init});if(url==='/api/bootstrap')return Response.json({token:'t',snapshot:{document,version:'v1'},runtimeStatus:{connected:false},geometry:{x:[11,108,205,302,399],y:[5,102,199]}});if(url.includes('/catalog/'))return Response.json([]);if(url==='/api/icon-packs')return Response.json([{id:packId,name:'Media',version:'1.0.0',author:'Example',iconCount:1,hasLicense:true}]);if(url.includes('/icons?'))return Response.json([{id:iconId,name:'Play',tags:['media'],animated:false}]);if(url==='/api/icon-packs/import')return Response.json({assetId:'c'.repeat(64)});return Response.json({error:'Not found'},{status:404});};
  const state=await StudioState.connect(request as typeof fetch);expect((await state.iconPacks())[0]?.name).toBe('Media');expect((await state.iconPackIcons(packId,'재생'))[0]?.name).toBe('Play');expect(await state.importIcon(packId,iconId)).toBe('c'.repeat(64));
  expect(calls.find(call=>call.url.includes('/icons?'))?.url).toBe(`/api/icon-packs/${packId}/icons?q=${encodeURIComponent('재생')}`);
  const imported=calls.find(call=>call.url==='/api/icon-packs/import')!;expect(imported.init?.method).toBe('POST');expect(imported.init?.body).toBe(JSON.stringify({packId,iconId}));
});
