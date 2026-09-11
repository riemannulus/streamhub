import {expect,test} from 'bun:test';
import type {DeckBackend,DeckBackendStatus,PreparedPresentation,PresentationRequest} from './backend';
import {defaultStudioDocument} from '../studio/document';

const surface=(identity:string)=>({identity,png:Buffer.from(identity),keyPngs:Array.from({length:15},()=>Buffer.from(identity))});
const request=(generation:string):PresentationRequest=>({generation,reason:'page',from:surface('from'),to:surface('to'),transition:defaultStudioDocument().motion.pageChange,inputEnabled:true});

test('backend contract keeps prepared values opaque and stop idempotent',async()=>{
  class MemoryBackend implements DeckBackend{
    private current?:PreparedPresentation;private stopped=false;
    async prepare(value:PresentationRequest){if(this.stopped)throw new Error('Backend stopped');return this.current={backend:'plugin',generation:value.generation,token:`token-${value.generation}`};}
    async present(value:PreparedPresentation){if(value!==this.current)throw new Error('Prepared presentation is stale');this.current=undefined;}
    status():DeckBackendStatus{return{mode:'plugin',state:this.stopped?'unavailable':'ready',connected:!this.stopped};}
    async stop(){this.stopped=true;this.current=undefined;}
  }
  const backend=new MemoryBackend(),prepared=await backend.prepare(request('g1'));
  expect(prepared).toEqual({backend:'plugin',generation:'g1',token:'token-g1'});
  await expect(backend.present(prepared)).resolves.toBeUndefined();
  await backend.stop();
  await expect(backend.stop()).resolves.toBeUndefined();
});
