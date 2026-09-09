import {expect,test} from 'bun:test';
import {PageBoard,validatePageConfig,type PageConfig} from './pages';
import {SessionDeck,type SessionRecord} from './index';
const record=(id:string,source='a'):SessionRecord=>({id,source,kind:'live',level:'info',label:id,revision:1,createdAt:1,updatedAt:1,freshness:'fresh',press:{type:'open',url:'https://example.com'}});
const config:PageConfig={defaultPage:'home',transition:'fade',durationMs:150,pages:[
  {id:'home',title:'Home',signals:{},buttons:[{index:13,type:'page',pageId:'work',label:'Work'}]},
  {id:'work',title:'Work',match:{appBundleId:'com.example.work'},signals:{source:'a'},buttons:[{index:13,type:'auto',label:'Auto'},{index:12,type:'text',label:'Status'}]},
]};
const click=(board:PageBoard,index:number)=>{board.down(index);return board.up(index);};

test('strict config rejects unknown targets, duplicate IDs/positions and unsafe values',()=>{
  expect(validatePageConfig(config)).toEqual(config);
  for(const raw of [null,{}, {...config,extra:true},{...config,defaultPage:'missing'},{...config,pages:[config.pages[0],config.pages[0]]},
    {...config,durationMs:501},{...config,durationMs:0},{...config,transition:'slide'},
    {...config,pages:[{id:'home',title:'Home',buttons:[{type:'page',index:0,pageId:'missing'}]}]},
    {...config,pages:[{id:'home',title:'Home',buttons:[{type:'auto',index:15}]}]},
    {...config,pages:[{id:'home',title:'Home',buttons:[{type:'auto',index:0},{type:'text',index:0,label:'x'}]}]},
    {...config,pages:[{id:'home',title:'Home',match:{appBundleId:'com.x',windowTitle:'x'}}]},
  ])expect(()=>validatePageConfig(raw)).toThrow();
});
test('source-filtered composition preserves stable inner slots and supports static overrides',()=>{
  const board=new PageBoard(config);const records=Array.from({length:13},(_,i)=>record(String(i)));
  board.update([...records,record('other','b')]);
  click(board,13);
  expect(board.page().viewId).toBe('work');
  expect(board.page().keys[12]).toMatchObject({type:'tile',label:'Status'});
  expect(board.page().pageCount).toBe(2);
  click(board,14);
  expect(board.page().keys[0]).toMatchObject({type:'signal',record:{id:'11'}});
  expect(board.page().keys.some(k=>k.type==='signal'&&k.record.source==='b')).toBe(false);
  board.update(records.filter(r=>r.id!=='0'));
  click(board,10);
  expect(board.page().keys[0]).toMatchObject({type:'empty'});
  expect(board.page().keys[1]).toMatchObject({type:'signal',record:{id:'1'}});
});
test('routing debounces repeated candidate, honors first match and retains view on unavailable context',()=>{
  const board=new PageBoard({...config,pages:[...config.pages,{id:'later',title:'Later',match:{appBundleId:'com.example.work'}}]});
  board.context({available:true,appBundleId:'com.example.work'},0);
  board.context({available:true,appBundleId:'com.example.work'},249);
  expect(board.page().viewId).toBe('home');
  board.context({available:true,appBundleId:'com.example.work'},250);
  expect(board.page().viewId).toBe('work');
  board.context({available:false,appBundleId:null},1000);
  expect(board.page().viewId).toBe('work');
  board.context({available:true,appBundleId:'unknown'},2000);
  board.context({available:true,appBundleId:'unknown'},2250);
  expect(board.page().viewId).toBe('home');
});
test('manual selection remains pinned until auto button is explicitly pressed',()=>{
  const board=new PageBoard(config);click(board,13);
  board.context({available:true,appBundleId:'unknown'},0);
  board.context({available:true,appBundleId:'unknown'},500);
  expect(board.page().viewId).toBe('work');
  expect(board.exportLayout().manual).toBe(true);
  click(board,13);
  expect(board.page().viewId).toBe('home');
  expect(board.exportLayout().manual).toBe(false);
});
test('automatic switch invalidates held signal and blocks new bindings until all holds release',()=>{
  const board=new PageBoard(config);board.update([record('x')]);board.down(0);
  const epoch=board.page().epoch;
  board.context({available:true,appBundleId:'com.example.work'},0);
  board.context({available:true,appBundleId:'com.example.work'},250);
  expect(board.page().epoch).toBeGreaterThan(epoch);
  board.down(1);expect(board.up(0)).toBeUndefined();
  board.down(13);expect(board.up(13)).toBeUndefined();
  expect(board.up(1)).toBeUndefined();
  expect(click(board,0)).toMatchObject({type:'effect',key:{id:'x'}});
});
test('revision updates and rejected release cancellation cannot execute stale bindings',()=>{
  const board=new PageBoard(config);board.update([record('x')]);board.down(0);
  board.update([{...record('x'),revision:2}]);expect(board.up(0)).toBeUndefined();
  board.down(0);board.cancelInput(0);expect(board.up(0)).toBeUndefined();
  expect(click(board,0)).toMatchObject({type:'effect',revision:2});
});
test('per-page layout and manual selection survive restart and legacy SessionDeck shape is unchanged',()=>{
  const board=new PageBoard(config);const records=Array.from({length:13},(_,i)=>record(String(i)));
  board.update(records);click(board,13);click(board,14);
  const restored=new PageBoard(config,JSON.parse(JSON.stringify(board.exportLayout())));restored.update([...records].reverse());
  expect(restored.page()).toMatchObject({viewId:'work',index:1,transition:{type:'fade',durationMs:150}});
  expect(restored.page().keys[0]).toMatchObject({type:'signal',record:{id:'11'}});
  expect(restored.exportLayout().manual).toBe(true);
  expect(new SessionDeck().page()).not.toHaveProperty('viewId');
});

test('content buttons reserve capacity so every signal remains accessible with stable slots',()=>{
  const board=new PageBoard({defaultPage:'home',pages:[{id:'home',title:'Home',signals:{},buttons:[{index:0,type:'text',label:'Fixed'}]}]});
  const records=Array.from({length:12},(_,i)=>record(String(i)));
  board.update(records);
  const first=board.page();
  expect(first.pageCount).toBe(2);
  expect(first.keys[0]).toMatchObject({type:'tile',label:'Fixed'});
  expect(first.keys[1]).toMatchObject({type:'signal',record:{id:'0'}});
  const ids=first.keys.flatMap(key=>key.type==='signal'?[key.record.id]:[]);
  click(board,14);
  ids.push(...board.page().keys.flatMap(key=>key.type==='signal'?[key.record.id]:[]));
  expect(ids).toEqual(records.map(record=>record.id));
  board.update(records.filter(record=>record.id!=='0'));
  click(board,10);
  expect(board.page().keys[1]).toMatchObject({type:'empty'});
  expect(board.page().keys[2]).toMatchObject({type:'signal',record:{id:'1'}});
  board.update([...records.filter(record=>record.id!=='0'),record('new')]);
  expect(board.page().keys[1]).toMatchObject({type:'signal',record:{id:'new'}});
});

test('signals page cannot reserve every content position and custom capacity retains pin navigation',()=>{
  const content=[0,1,2,3,4,5,6,7,8,9,11,12];
  expect(()=>validatePageConfig({defaultPage:'home',pages:[{id:'home',title:'Home',signals:{},buttons:content.map(index=>({index,type:'text',label:'Fixed'}))}]})).toThrow();
  const deck=new SessionDeck(undefined,[0,1]);
  deck.update([record('a'),record('b'),{...record('urgent'),level:'urgent'}]);
  expect(deck.page().pageCount).toBe(2);
  deck.down(13);expect(deck.up(13)).toMatchObject({type:'navigate',page:1});
  expect(deck.page().keys[0]).toMatchObject({type:'signal',record:{id:'urgent'}});
  expect(()=>new SessionDeck(undefined,[])).toThrow();
  expect(()=>new SessionDeck(undefined,[0,0])).toThrow();
  expect(()=>new SessionDeck(undefined,[10])).toThrow();
});

test('changing content capacity preserves saved slots and clamps only the inner page',()=>{
  const original:PageConfig={defaultPage:'home',pages:[{id:'home',title:'Home',signals:{},buttons:[{index:0,type:'text',label:'Fixed'}]}]};
  const board=new PageBoard(original);const records=Array.from({length:12},(_,i)=>record(String(i)));
  board.update(records);click(board,14);
  const saved=board.exportLayout();expect(saved.pages.home!.currentPage).toBe(1);
  const changed:PageConfig={defaultPage:'home',pages:[{id:'home',title:'Home',signals:{}}]};
  const restored=new PageBoard(changed,saved);restored.update([...records].reverse());
  expect(restored.page()).toMatchObject({index:0,pageCount:1});
  expect(restored.exportLayout().pages.home!.slots).toEqual(saved.pages.home!.slots);
  expect(restored.page().keys[0]).toMatchObject({type:'signal',record:{id:'0'}});
  expect(saved.pages.home!.currentPage).toBe(1);
  for(const corrupt of [
    {...saved.pages.home!,currentPage:-1},
    {...saved.pages.home!,currentPage:100},
    {...saved.pages.home!,currentPage:0.5},
    {...saved.pages.home!,slots:[{source:'a',id:'x'},{source:'a',id:'x'}]},
    {...saved.pages.home!,slots:[{source:3,id:'x'}]},
  ])expect(()=>new PageBoard(changed,{...saved,pages:{home:corrupt}} as typeof saved)).toThrow();
});

test('builtin button styles survive validation and project onto every tile type',()=>{
  const config:PageConfig={defaultPage:'home',pages:[{id:'home',title:'Home',buttons:[
    {index:0,type:'text',label:'Text',color:'#12abEF',icon:'folder'},
    {index:1,type:'page',pageId:'home',color:'#123456',icon:'terminal'},
    {index:2,type:'auto',color:'#abcdef',icon:'check'},
  ]}]};
  const board=new PageBoard(validatePageConfig(config));
  expect(board.page().keys[0]).toMatchObject({color:'#12abEF',icon:'folder'});
  expect(board.page().keys[1]).toMatchObject({color:'#123456',icon:'terminal'});
  expect(board.page().keys[2]).toMatchObject({color:'#abcdef',icon:'check'});
  for(const style of [{color:'red'},{color:'#123'},{color:'#123456\"/>'},{icon:'<svg>'},{icon:'toString'},{icon:23}]){
    expect(()=>validatePageConfig({defaultPage:'home',pages:[{id:'home',title:'Home',buttons:[{index:0,type:'text',label:'Text',...style}]}]})).toThrow();
  }
});

test('window and monitor rules use priority, stable ties and unknown context retention',()=>{
  const cfg:PageConfig={defaultPage:'home',pages:[{id:'home',title:'Home'},
    {id:'app',title:'App',match:{appBundleId:'test.editor'}},
    {id:'project',title:'Project',priority:10,match:{appBundleId:'test.editor',windowTitle:{mode:'contains',value:'Streamhub'},displayId:'2'}},
    {id:'tie',title:'Tie',priority:10,match:{windowTitle:{mode:'equals',value:'Streamhub'},displayId:'2'}},
  ]};
  const board=new PageBoard(cfg);
  const route=(ctx:Parameters<PageBoard['context']>[0],time:number)=>{board.context(ctx,time);board.context(ctx,time+250);};
  route({available:true,appBundleId:'test.editor',windowTitle:'Streamhub',displayId:'2'},0);
  expect(board.page().viewId).toBe('project');
  expect(board.selectionReason()).toContain('Project');
  route({available:true,appBundleId:'test.editor',windowTitle:null,displayId:'2'},1000);
  expect(board.page().viewId).toBe('project');expect(board.selectionReason()).toContain('미확인');
  route({available:true,appBundleId:'test.editor',windowTitle:'Other',displayId:'2'},2000);
  expect(board.page().viewId).toBe('app');
  route({available:true,appBundleId:'other.app',windowTitle:null,displayId:'3'},3000);
  expect(board.page().viewId).toBe('home');
  for(const match of [{},{windowTitle:{mode:'regex',value:'.*'}},{windowTitle:{mode:'equals',value:''}},{displayId:4}])expect(()=>validatePageConfig({defaultPage:'x',pages:[{id:'x',title:'X',match}]})).toThrow();
  for(const priority of [1.5,1001,-1001,'high'])expect(()=>validatePageConfig({defaultPage:'x',pages:[{id:'x',title:'X',priority}]})).toThrow();
});

test('action buttons emit one safe intent and remain gated while running',()=>{
  const cfg:PageConfig={defaultPage:'home',pages:[{id:'home',title:'Home',buttons:[
    {index:0,type:'open',url:'https://example.com',label:'Open'},
    {index:1,type:'app',bundleId:'com.apple.Terminal'},
    {index:2,type:'action',name:'build',args:{target:'test'}},
  ]}]};
  const board=new PageBoard(cfg);
  expect(click(board,0)).toMatchObject({type:'button-effect',pageId:'home',index:0,effect:{type:'open',url:'https://example.com/'}});
  expect(board.up(0)).toBeUndefined();expect(click(board,0)).toBeUndefined();
  expect(board.page().keys[0]).toMatchObject({foot:'실행 중',enabled:false});
  board.setActionStatus('home',0,'success');
  expect(board.page().keys[0]).toMatchObject({foot:'완료',enabled:true});
  expect(click(board,0)?.type).toBe('button-effect');
  board.down(1);board.cancelInput();expect(board.up(1)).toBeUndefined();
  expect(click(board,1)).toMatchObject({effect:{type:'app',bundleId:'com.apple.Terminal'}});
  expect(click(board,2)).toMatchObject({effect:{type:'action',name:'build',args:{target:'test'}}});
  board.setActionStatus('home',2,'error','실행 실패');expect(board.page().keys[2]).toMatchObject({foot:'실행 실패'});
  for(const button of [{type:'open',url:'file:///tmp/x'},{type:'open',url:'https://user:pass@example.com'},{type:'app',bundleId:'x;rm'},{type:'action',name:'build',args:{x:1}},{type:'action',name:'build',args:{},exec:['sh']}])expect(()=>validatePageConfig({defaultPage:'home',pages:[{id:'home',title:'Home',buttons:[{index:0,...button}]}]})).toThrow();
});
