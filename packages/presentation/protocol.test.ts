import {describe,expect,test} from 'bun:test';import {parsePluginMessage,parseRuntimeMessage} from './protocol';
const png='data:image/png;base64,iVBORw0KGgo=';
const jpeg='data:image/jpeg;base64,/9j/2Q==';
describe('plugin protocol',()=>{
  test('accepts prepared and resumable presentations with fifteen JPEG or PNG frames',()=>{
    const frames=Array.from({length:15},(_,index)=>({index,offsetMs:index+1,keys:Array(15).fill(index===14?png:jpeg)}));
    const message=parseRuntimeMessage({v:1,type:'presentation',trigger:'unlock',delivery:'prepare',startKeys:Array(15).fill(png),plan:{generation:'g',frames},inputEnabled:false});
    expect(message).toMatchObject({type:'presentation',delivery:'prepare',startKeys:Array(15).fill(png)});
  });
  test('accepts bounded messages',()=>{expect(parsePluginMessage({v:1,type:'cells-ready',deviceId:'deck'})).toEqual({v:1,type:'cells-ready',deviceId:'deck'});expect(parsePluginMessage({v:1,type:'key',phase:'down',index:14,generation:'g'})).toMatchObject({index:14});expect(parsePluginMessage({v:1,type:'frame-sent',generation:'g',frame:14})).toMatchObject({frame:14});expect(parseRuntimeMessage({v:1,type:'presentation',trigger:'unlock',plan:{generation:'g',frames:[{index:0,offsetMs:0,keys:Array(15).fill(png)}]},inputEnabled:false})).toMatchObject({type:'presentation',delivery:'immediate'});});
  test('rejects unknown, oversized and unsafe payloads',()=>{for(const bad of [{v:2,type:'cells-ready',deviceId:'x'},{v:1,type:'key',phase:'down',index:15,generation:'g'},{v:1,type:'cells-ready',deviceId:'x',extra:true}])expect(()=>parsePluginMessage(bad)).toThrow();expect(()=>parseRuntimeMessage({v:1,type:'presentation',trigger:'page',plan:{generation:'g',frames:[{index:0,offsetMs:0,keys:Array(15).fill('file:///x')}]},inputEnabled:true})).toThrow();});
});
