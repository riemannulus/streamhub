import type {ActionProgram,ActionSequence,ButtonAction} from '../studio/document';

export type ActionResult={ok:true}|{ok:false;code:string;message:string};
export type ProgramContext={signal:AbortSignal;run:(action:ButtonAction,signal:AbortSignal)=>Promise<ActionResult>;sleep?:(milliseconds:number,signal:AbortSignal)=>Promise<boolean>};
const cancelled:ActionResult={ok:false,code:'cancelled',message:'Action cancelled'};

function sleep(milliseconds:number,signal:AbortSignal):Promise<boolean>{
  if(signal.aborted)return Promise.resolve(false);
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve(true);},milliseconds);
    const abort=()=>{clearTimeout(timer);resolve(false);};
    signal.addEventListener('abort',abort,{once:true});
  });
}
async function runLeaf(action:ButtonAction,context:ProgramContext):Promise<ActionResult>{
  if(context.signal.aborted)return cancelled;
  try{
    const result=await context.run(action,context.signal);
    return context.signal.aborted?cancelled:result;
  }catch(error){
    if(context.signal.aborted)return cancelled;
    return{ok:false,code:typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'execution-failed',message:error instanceof Error?error.message:'Action failed'};
  }
}
async function executeSequence(sequence:ActionSequence,context:ProgramContext):Promise<ActionResult>{
  if(context.signal.aborted)return cancelled;
  if(sequence.mode==='parallel'){
    if(sequence.steps.some(step=>step.type==='delay'))return{ok:false,code:'invalid-program',message:'Parallel sequences cannot contain delays'};
    const results=await Promise.all(sequence.steps.map(step=>runLeaf((step as Extract<typeof step,{type:'action'}>).action,context)));
    if(context.signal.aborted)return cancelled;
    return results.find(result=>!result.ok)??{ok:true};
  }
  for(const step of sequence.steps){
    if(context.signal.aborted)return cancelled;
    if(step.type==='delay'){
      if(!await (context.sleep??sleep)(step.milliseconds,context.signal))return cancelled;
      continue;
    }
    const result=await runLeaf(step.action,context);if(!result.ok)return result;
  }
  return{ok:true};
}

/** Executes an already validated, non-recursive program. It never retries a leaf action. */
export async function executeProgram(program:ActionProgram,context:ProgramContext):Promise<ActionResult>{
  if(context.signal.aborted)return cancelled;
  if(program.type==='single')return runLeaf(program.action,context);
  if(program.type==='sequence')return executeSequence(program.sequence,context);
  return executeSequence(program.initial==='off'?program.offToOn:program.onToOff,context);
}
