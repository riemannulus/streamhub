import {describe,expect,test} from 'bun:test';
import {defaultStudioDocument,primaryButtonAction,singlePressBehavior,validateKeyBehavior,validateStudioDocument} from './document';

const icon='a'.repeat(64);
const background='b'.repeat(64);

describe('StudioDocument v3',()=>{
  test('separates action and appearance and clones the accepted document',()=>{
    const raw={...defaultStudioDocument({id:'11111111-1111-4111-8111-111111111111'}),pages:[{id:'home',title:'홈',buttons:[{
      id:'firefox',index:0,
      behavior:singlePressBehavior({type:'open-app',bundleId:'org.mozilla.firefox'}),
      appearance:{
        contentMode:'icon-and-label',
        icon:{assetId:icon,fit:'contain'},
        label:{text:'Firefox',position:'bottom',size:'medium',color:'#ffffff'},
        background:{color:'#101820',assetId:background,opacity:0.75},
      },
    }]}]};
    const before=structuredClone(raw);
    const result=validateStudioDocument(raw,{assets:[icon,background]});
    expect(result).toEqual(before as any);
    expect(result).not.toBe(raw);
    expect(result.pages[0].buttons?.[0]).not.toBe(raw.pages[0].buttons[0]);
  });

  test('supports icon-only, label-only and hidden buttons',()=>{
    const document=defaultStudioDocument({id:'22222222-2222-4222-8222-222222222222'});
    document.pages[0].buttons=[
      {id:'icon',index:0,behavior:singlePressBehavior({type:'none'}),appearance:{contentMode:'icon-only',icon:{assetId:icon,fit:'cover'}}},
      {id:'label',index:1,behavior:singlePressBehavior({type:'page-indicator'}),appearance:{contentMode:'label-only',label:{text:'1 / 1',position:'center',size:'large',color:'#ffffff'}}},
      {id:'hidden',index:2,behavior:singlePressBehavior({type:'open-url',url:'https://example.com/'}),appearance:{contentMode:'hidden'}},
    ];
    expect(validateStudioDocument(document,{assets:[icon]}).pages[0].buttons).toHaveLength(3);
  });

  test('validates every core action and normalizes URLs',()=>{
    const document=defaultStudioDocument({id:'33333333-3333-4333-8333-333333333333'});
    const appearance={contentMode:'hidden' as const};
    document.pages=[
      {id:'home',title:'홈',buttons:[
        {id:'path',index:0,behavior:singlePressBehavior({type:'open-path',path:'/Users/example/file.txt'}),appearance},
        {id:'url',index:1,behavior:singlePressBehavior({type:'open-url',url:'https://example.com'}),appearance},
        {id:'hotkey',index:2,behavior:singlePressBehavior({type:'hotkey',keys:['command','shift','p']}),appearance},
        {id:'text',index:3,behavior:singlePressBehavior({type:'text',text:'hello',mode:'paste'}),appearance},
        {id:'media',index:4,behavior:singlePressBehavior({type:'media',command:'play-pause'}),appearance},
        {id:'registered',index:5,behavior:singlePressBehavior({type:'registered',name:'build',args:{target:'app'}}),appearance},
        {id:'next',index:6,behavior:singlePressBehavior({type:'next-page'}),appearance},
        {id:'previous',index:7,behavior:singlePressBehavior({type:'previous-page'}),appearance},
        {id:'target',index:8,behavior:singlePressBehavior({type:'go-to-page',pageId:'web'}),appearance},
        {id:'auto',index:9,behavior:singlePressBehavior({type:'resume-auto-page'}),appearance},
      ]},
      {id:'web',title:'웹'},
    ];
    const result=validateStudioDocument(document,{actions:{build:{args:{target:{}}}}});
    expect(primaryButtonAction(result.pages[0].buttons![1]!)).toMatchObject({type:'open-url',url:'https://example.com/'});
  });

  test('rejects invalid IDs, modes, values, references and limits',()=>{
    const mutate=(fn:(document:ReturnType<typeof defaultStudioDocument>)=>void)=>{const document=defaultStudioDocument();fn(document);return()=>validateStudioDocument(document,{assets:[icon]});};
    expect(mutate(document=>{document.id='not-a-uuid';})).toThrow('document ID');
    expect(mutate(document=>{document.pages[0].buttons=[{id:'x',index:0,behavior:singlePressBehavior({type:'none'}),appearance:{contentMode:'icon-only'}} as any];})).toThrow('icon');
    expect(mutate(document=>{document.pages[0].buttons=[{id:'x',index:0,behavior:singlePressBehavior({type:'none'}),appearance:{contentMode:'label-only'}} as any];})).toThrow('label');
    expect(mutate(document=>{document.pages[0].buttons=[{id:'x',index:0,behavior:singlePressBehavior({type:'hotkey',keys:['command','command']}),appearance:{contentMode:'hidden'}} as any];})).toThrow('hotkey');
    expect(mutate(document=>{document.pages[0].buttons=[{id:'x',index:0,behavior:singlePressBehavior({type:'go-to-page',pageId:'missing'}),appearance:{contentMode:'hidden'}}];})).toThrow('target page');
    expect(mutate(document=>{document.pages[0].buttons=[{id:'x',index:0,behavior:singlePressBehavior({type:'none'}),appearance:{contentMode:'hidden'}},{id:'x',index:1,behavior:singlePressBehavior({type:'none'}),appearance:{contentMode:'hidden'}}];})).toThrow('button ID');
    expect(mutate(document=>{document.pages[0].buttons=[{id:'x',index:0,behavior:singlePressBehavior({type:'none'}),appearance:{contentMode:'hidden'}},{id:'y',index:0,behavior:singlePressBehavior({type:'none'}),appearance:{contentMode:'hidden'}}];})).toThrow('button index');
    expect(mutate(document=>{document.pages=Array.from({length:33},(_,index)=>({id:`p-${index}`,title:'x'}));document.defaultPageId='p-0';})).toThrow('1–32 pages');
    expect(()=>validateStudioDocument({...defaultStudioDocument(),extra:true})).toThrow('Unknown');
  });

  test('validates non-recursive advanced behavior bounds and navigation placement',()=>{
    const single=singlePressBehavior({type:'open-app',bundleId:'org.mozilla.firefox'});
    expect(validateKeyBehavior(single)).toEqual(single);
    expect(validateKeyBehavior(single)).not.toBe(single);
    const sequence=(steps:unknown[],mode:'sequential'|'parallel'='sequential')=>({press:{type:'sequence',sequence:{mode,steps}},doublePressMs:300,holdMs:500});
    expect(()=>validateKeyBehavior({doublePressMs:300,holdMs:500})).toThrow('branch');
    expect(()=>validateKeyBehavior(sequence([]))).toThrow('1–16');
    expect(()=>validateKeyBehavior(sequence(Array.from({length:17},()=>({type:'action',action:{type:'media',command:'play-pause'}}))))).toThrow('1–16');
    for(const milliseconds of [9,30_001])expect(()=>validateKeyBehavior(sequence([{type:'delay',milliseconds}]))).toThrow('10–30000');
    expect(()=>validateKeyBehavior(sequence([{type:'delay',milliseconds:10}],'parallel'))).toThrow('Parallel');
    expect(()=>validateKeyBehavior(sequence([{type:'action',action:{type:'page-indicator'}}]))).toThrow('executable');
    expect(()=>validateKeyBehavior(sequence([{type:'action',action:{type:'next-page'}},{type:'action',action:{type:'media',command:'play-pause'}}]))).toThrow('final');
    expect(()=>validateKeyBehavior(sequence([{type:'action',action:{type:'next-page'}}],'parallel'))).toThrow('final');
    for(const doublePressMs of [149,751])expect(()=>validateKeyBehavior({...single,doublePressMs})).toThrow('150–750');
    for(const holdMs of [299,2_001,300])expect(()=>validateKeyBehavior({...single,holdMs})).toThrow(holdMs===300?'greater':'300–2000');
  });
});
