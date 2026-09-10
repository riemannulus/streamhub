export type Gesture='press'|'double-press'|'hold';
export type GestureInput=
  |{type:'down';key:number;bindingRevision:number;at:number}
  |{type:'up';key:number;bindingRevision:number;at:number}
  |{type:'cancel-all';reason:string;at:number};
export type GestureBranches={press?:boolean;doublePress?:boolean;hold?:boolean;doublePressMs:number;holdMs:number};
type Timer={cancel():void};
type State={revision:number;lastAt:number;phase:'down'|'waiting'|'second-down'|'held';branches:GestureBranches;hold?:Timer;press?:Timer;deadline?:number};

export function createGestureRecognizer(options:{schedule:(delayMs:number,callback:()=>void)=>Timer;resolve:(key:number,revision:number)=>GestureBranches|undefined;emit:(key:number,revision:number,gesture:Gesture)=>void}){
  const states=new Map<number,State>();
  const cancel=(key:number)=>{const state=states.get(key);state?.hold?.cancel();state?.press?.cancel();states.delete(key);};
  const begin=(key:number,revision:number,at:number)=>{
    const branches=options.resolve(key,revision);if(!branches)return;
    const state:State={revision,lastAt:at,phase:'down',branches};states.set(key,state);
    if(branches.hold)state.hold=options.schedule(branches.holdMs,()=>{if(states.get(key)!==state||state.phase!=='down')return;state.phase='held';state.lastAt=at+branches.holdMs;options.emit(key,revision,'hold');});
  };
  return{accept(input:GestureInput){
    if(input.type==='cancel-all'){for(const key of [...states.keys()])cancel(key);return;}
    const state=states.get(input.key);
    if(input.type==='down'){
      if(state&&input.bindingRevision!==state.revision){cancel(input.key);begin(input.key,input.bindingRevision,input.at);return;}
      if(state?.phase==='waiting'&&input.at>=state.lastAt&&input.at<=(state.deadline??-1)&&state.branches.doublePress){state.press?.cancel();state.press=undefined;state.phase='second-down';state.lastAt=input.at;return;}
      if(state)return;
      begin(input.key,input.bindingRevision,input.at);return;
    }
    if(!state||input.bindingRevision!==state.revision||input.at<state.lastAt)return;
    if(state.phase==='held'){cancel(input.key);return;}
    if(state.phase==='second-down'){cancel(input.key);if(state.branches.doublePress)options.emit(input.key,input.bindingRevision,'double-press');return;}
    if(state.phase!=='down')return;
    state.hold?.cancel();state.hold=undefined;state.lastAt=input.at;
    if(!state.branches.doublePress){cancel(input.key);if(state.branches.press)options.emit(input.key,input.bindingRevision,'press');return;}
    state.phase='waiting';state.deadline=input.at+state.branches.doublePressMs;
    state.press=options.schedule(state.branches.doublePressMs,()=>{if(states.get(input.key)!==state||state.phase!=='waiting')return;states.delete(input.key);if(state.branches.press)options.emit(input.key,input.bindingRevision,'press');});
  }};
}
