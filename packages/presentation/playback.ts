export type PlannedFrame={index:number;offsetMs:number;keys:readonly string[]};
export type FramePlan={generation:string;frames:readonly PlannedFrame[]};
export type PlaybackResult={generation:string;sent:number[];aborted:boolean;startedAt:number;finishedAt:number};
type PlaybackOptions={signal?:AbortSignal;now?:()=>number;wait?:(milliseconds:number,signal:AbortSignal)=>Promise<void>};

const sleep=(milliseconds:number,signal:AbortSignal)=>new Promise<void>(resolve=>{
  if(signal.aborted){resolve();return;}
  const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
  const timer=setTimeout(done,milliseconds);
  signal.addEventListener('abort',done,{once:true});
});

function validate(plan:FramePlan):void{
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(plan.generation)||!Array.isArray(plan.frames)||!plan.frames.length||plan.frames.length>15)throw new Error('Invalid frame plan');
  for(const [position,frame] of plan.frames.entries()){
    if(frame.index!==position||!Number.isFinite(frame.offsetMs)||frame.offsetMs<0||frame.keys.length!==15)throw new Error('Invalid frame plan');
    if(position>0&&frame.offsetMs<=plan.frames[position-1]!.offsetMs)throw new Error('Frame offsets must increase');
  }
}

export async function playFramePlan(plan:FramePlan,sink:(frame:PlannedFrame,signal:AbortSignal)=>Promise<void>,options:PlaybackOptions={}):Promise<PlaybackResult>{
  validate(plan);
  const controller=options.signal?undefined:new AbortController();
  const signal=options.signal??controller!.signal;
  const now=options.now??(()=>performance.now());
  const wait=options.wait??sleep;
  const startedAt=now(),sent:number[]=[];
  for(const [position,frame] of plan.frames.entries()){
    if(signal.aborted)break;
    const deadline=startedAt+frame.offsetMs;
    const final=position===plan.frames.length-1;
    if(position>0&&!final&&now()>deadline)continue;
    const remaining=deadline-now();
    if(remaining>0)await wait(remaining,signal);
    if(signal.aborted)break;
    if(position>0&&!final&&now()>deadline)continue;
    await sink(frame,signal);
    if(signal.aborted)break;
    sent.push(frame.index);
  }
  return{generation:plan.generation,sent,aborted:signal.aborted,startedAt,finishedAt:now()};
}
