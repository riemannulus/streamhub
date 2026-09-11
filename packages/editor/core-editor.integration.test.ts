import {afterEach,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DeckBackend,DeckBackendStatus,PreparedPresentation,PresentationRequest} from '../presentation/backend';
import {singlePressBehavior,type ButtonAction,type ButtonDefinition,type StudioDocument} from '../studio/document';
import type {ButtonEffect} from '../streamdeck';
import {SignalStore} from '../host/src/store';
import {startPresentationCoordinator,type PresentationCoordinator} from '../host/src/presentation';
import {startServer} from '../host/src/server';
import {startEditorServer} from './server';

const adminToken='a'.repeat(32),sourceToken='b'.repeat(32);
let directory='',editor:ReturnType<typeof startEditorServer>|undefined,host:ReturnType<typeof startServer>|undefined,presentation:PresentationCoordinator|undefined,store:SignalStore|undefined;

afterEach(async()=>{
  await editor?.stop();editor=undefined;
  host?.stop(true);host=undefined;
  await presentation?.stop();presentation=undefined;
  store?.close();store=undefined;
  delete process.env.STREAMHUB_CONFIG;
  if(directory)rmSync(directory,{recursive:true,force:true});directory='';
});

const appearance=(label:string):ButtonDefinition['appearance']=>({contentMode:'label-only',label:{text:label,position:'center',size:'small',color:'#ffffff'}});
const button=(id:string,index:number,label:string,action:ButtonAction):ButtonDefinition=>({id,index,behavior:singlePressBehavior(action),appearance:appearance(label)});
class TestBackend implements DeckBackend{
  requests:PresentationRequest[]=[];
  async prepare(request:PresentationRequest){this.requests.push(request);return{backend:'plugin' as const,generation:request.generation,token:request.generation};}
  async present(_value:PreparedPresentation){}
  status():DeckBackendStatus{return{mode:'plugin',state:'ready',connected:true};}
  async stop(){}
}
const frameHash=(backend:TestBackend)=>createHash('sha256').update(backend.requests.at(-1)!.to.keyPngs.map(bytes=>`data:image/png;base64,${bytes.toString('base64')}`).join('\n')).digest('hex');

test('blank Studio builds, applies and operates a complete three-page core deck',async()=>{
  directory=mkdtempSync(join(tmpdir(),'streamhub-core-editor-'));
  store=new SignalStore(':memory:');
  const backend=new TestBackend(),effects:ButtonEffect[]=[];
  presentation=await startPresentationCoordinator({
    store,directory:join(directory,'studio'),backend,
    execute:async effect=>{effects.push(effect);},
  });
  host=startServer({store,port:0,adminToken,sources:{demo:{token:sourceToken}},studio:presentation});
  process.env.STREAMHUB_CONFIG=join(directory,'config.json');
  writeFileSync(process.env.STREAMHUB_CONFIG,JSON.stringify({port:host.port,adminToken,sources:{demo:{token:sourceToken}}}));
  writeFileSync(join(directory,'index.html'),'<html>Studio</html>');
  editor=startEditorServer({port:0,assetsDir:directory});

  const bootstrap=await (await fetch(`${editor.url}/api/bootstrap`)).json() as {token:string;snapshot:{document:StudioDocument;version:string}};
  expect(bootstrap.snapshot.document.pages.map(page=>page.title)).toEqual(['홈']);
  const document=structuredClone(bootstrap.snapshot.document);
  document.motion.pageChange={type:'none',durationMs:0};
  document.pages=[
    {id:'home',title:'홈',appearance:{color:'#112233'},buttons:[
      button('firefox',0,'Firefox',{type:'open-app',bundleId:'org.mozilla.firefox'}),
      button('website',1,'웹사이트',{type:'open-url',url:'https://example.com'}),
      button('hotkey',2,'복사',{type:'hotkey',keys:['command','c']}),
      button('text',3,'텍스트',{type:'text',text:'Streamhub',mode:'type'}),
      button('media',4,'재생',{type:'media',command:'play-pause'}),
      button('previous',10,'이전',{type:'previous-page'}),
      button('next',11,'다음',{type:'next-page'}),
      button('direct-media',12,'미디어',{type:'go-to-page',pageId:'media'}),
      button('indicator',13,'페이지',{type:'page-indicator'}),
      button('automatic',14,'자동',{type:'resume-auto-page'}),
    ]},
    {id:'web',title:'웹',appearance:{color:'#224466'},buttons:[
      button('web-previous',10,'이전',{type:'previous-page'}),
      button('web-next',11,'다음',{type:'next-page'}),
      button('web-direct-media',12,'미디어',{type:'go-to-page',pageId:'media'}),
      button('web-indicator',13,'페이지',{type:'page-indicator'}),
      button('web-automatic',14,'자동',{type:'resume-auto-page'}),
    ]},
    {id:'media',title:'미디어',appearance:{color:'#663322'},buttons:[
      button('media-previous',10,'이전',{type:'previous-page'}),
      button('media-next',11,'다음',{type:'next-page'}),
      button('media-direct-home',12,'홈',{type:'go-to-page',pageId:'home'}),
      button('media-indicator',13,'페이지',{type:'page-indicator'}),
      button('media-automatic',14,'자동',{type:'resume-auto-page'}),
    ]},
  ];

  const applied=await fetch(`${editor.url}/api/apply`,{method:'POST',headers:{'Content-Type':'application/json','X-Streamhub-Editor':bootstrap.token},body:JSON.stringify({document,expectedVersion:bootstrap.snapshot.version})});
  expect(applied.status).toBe(200);
  expect((await applied.json() as {runtimeStatus:{connected:boolean}}).runtimeStatus.connected).toBe(true);
  expect(presentation.snapshot().document.pages.map(page=>page.title)).toEqual(['홈','웹','미디어']);

  const press=async(index:number)=>{
    const generation=presentation!.status().generation!;
    await presentation!.key({phase:'down',index,generation});
    await presentation!.key({phase:'up',index,generation});
  };
  const hashes:Record<string,string>={home:frameHash(backend)};
  for(const index of [0,1,2,3,4])await press(index);
  expect(effects).toEqual([
    {type:'app',bundleId:'org.mozilla.firefox'},
    {type:'open',url:'https://example.com/'},
    {type:'hotkey',keys:['command','c']},
    {type:'text',text:'Streamhub',mode:'type'},
    {type:'media',command:'play-pause'},
  ]);
  hashes.homeAfterActions=frameHash(backend);

  await press(11);hashes.web=frameHash(backend);
  await press(12);hashes.media=frameHash(backend);
  await press(10);hashes.webAfterPrevious=frameHash(backend);
  const beforeIndicator=backend.requests.length;await press(13);expect(backend.requests).toHaveLength(beforeIndicator);
  await press(14);hashes.homeAfterAutomatic=frameHash(backend);
  expect(effects).toHaveLength(5);
  expect(hashes).toEqual({
    home:'eca5a48af45f36d3e3b0ca1e588cf59d2809f427e5fa0ac1461294e04e9caafd',
    homeAfterActions:'0a8b3d756c4df1c9ef60b59b1bf183bd22b7fd1c69fd15fa653994f327ee3bdf',
    web:'bc7147528213a40b844c6b43fd79a8f19ab74d03f175a8c38b50cf251812f4d7',
    media:'512ff3ab083440443fc26f6e497c3f14470de60453524d4e5c9570fae5b558f7',
    webAfterPrevious:'bc7147528213a40b844c6b43fd79a8f19ab74d03f175a8c38b50cf251812f4d7',
    homeAfterAutomatic:'882c27984d195e0aae40f2723640ed12935dc4b8e6b2132ed996e92326305a49',
  });
});
