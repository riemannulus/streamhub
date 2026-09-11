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

test('prepared unlock paints standby first and resumes once after all cells are ready',async()=>{
  const start='data:image/png;base64,c3RhcnQ=',middle='data:image/jpeg;base64,bWlkZGxl',final='data:image/png;base64,ZmluYWw=';
  const messages:any[]=[],writes=Array.from({length:15},()=>[] as Array<{image:string;target?:number}>);let cached:any;
  const controller=new CanvasController({send:message=>messages.push(message),cache:{save(message){cached=message;},load:()=>cached}});
  controller.connection(true);
  const plan={generation:'resume-1',frames:[{index:0,offsetMs:0,keys:Array(15).fill(middle)},{index:1,offsetMs:1,keys:Array(15).fill(final)}]};
  await controller.receive({v:1,type:'presentation',trigger:'unlock',delivery:'prepare',startKeys:Array(15).fill(start),inputEnabled:false,plan});
  for(let index=0;index<14;index++)await controller.appear(index,{setImage:async(image:string,options?:{target?:number})=>{writes[index]!.push({image,target:options?.target});}});
  await controller.receive({v:1,type:'presentation',trigger:'unlock',delivery:'resume',startKeys:Array(15).fill(start),inputEnabled:true,plan});
  expect(writes.flat()).toHaveLength(14);
  await controller.appear(14,{setImage:async(image:string,options?:{target?:number})=>{writes[14]!.push({image,target:options?.target});}});
  expect(writes.every(cell=>cell.map(write=>write.image).join(',')===[start,middle,final].join(','))).toBe(true);
  expect(writes.every(cell=>cell.map(write=>write.target).join(',')==='1,1,0')).toBe(true);
  expect(messages.filter(message=>message.type==='cells-ready')).toHaveLength(1);
  expect(messages.filter(message=>message.type==='frame-sent').map(message=>message.frame)).toEqual([0,1]);
});
