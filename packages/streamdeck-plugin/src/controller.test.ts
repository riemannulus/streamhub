import {expect,test} from 'bun:test';import {CanvasController} from './controller';
const image='data:image/png;base64,iVBORw0KGgo=';
test('waits for fifteen cells, sends each frame concurrently and forwards gated input',async()=>{const sent:string[][]=[],messages:any[]=[],controller=new CanvasController({send:m=>messages.push(m),cache:{save(){},load:()=>undefined}});controller.connection(true);for(let i=0;i<15;i++)await controller.appear(i,{setImage:async value=>{(sent.at(-1)??sent[sent.push([])-1]!).push(value)}});expect(messages.at(-1)).toMatchObject({type:'cells-ready'});await controller.receive({v:1,type:'presentation',trigger:'initial',inputEnabled:true,plan:{generation:'g',frames:[{index:0,offsetMs:0,keys:Array(15).fill(image)}]}});expect(sent.flat()).toHaveLength(15);controller.key(0,'down');expect(messages.at(-1)).toMatchObject({type:'key',phase:'down',generation:'g'});});

test('action instance replacement neither floods readiness nor lets stale disappear remove new cells',async()=>{
  const messages:any[]=[],oldWrites:number[]=[],newWrites:number[]=[];
  const controller=new CanvasController({send:m=>messages.push(m),cache:{save(){},load:()=>undefined}});
  controller.connection(true);
  const old=Array.from({length:15},(_,index)=>({setImage:async()=>{oldWrites.push(index)}}));
  const replacement=Array.from({length:15},(_,index)=>({setImage:async()=>{newWrites.push(index)}}));
  for(let index=0;index<15;index++)await controller.appear(index,old[index]!);
  for(let index=0;index<15;index++)await controller.appear(index,replacement[index]!);
  for(let index=0;index<15;index++)controller.disappear(index,old[index]!);
  expect(messages.filter(message=>message.type==='cells-ready')).toHaveLength(1);
  await controller.receive({v:1,type:'presentation',trigger:'reconnect',inputEnabled:true,plan:{generation:'replacement',frames:[{index:0,offsetMs:0,keys:Array(15).fill(image)}]}});
  expect(newWrites).toHaveLength(15);
  expect(oldWrites).toHaveLength(0);
});

test('announces readiness only after both transport and all cells are available',async()=>{
  const messages:any[]=[],controller=new CanvasController({send:m=>messages.push(m),cache:{save(){},load:()=>undefined}});
  for(let index=0;index<15;index++)await controller.appear(index,{setImage:async()=>{}});
  expect(messages.filter(message=>message.type==='cells-ready')).toHaveLength(0);
  controller.connection(true);
  expect(messages.filter(message=>message.type==='cells-ready')).toHaveLength(1);
  controller.connection(false);
  controller.connection(true);
  expect(messages.filter(message=>message.type==='cells-ready')).toHaveLength(2);
});
