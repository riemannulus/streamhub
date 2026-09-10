export type PlaybackMark='warming'|'cells-ready'|'first-frame-sent'|'final-frame-sent';
export type PlaybackMetric={warmupMs?:number;startMs?:number;playbackMs?:number;totalStreamhubMs?:number};

export class PlaybackRecorder{
  private readonly marks=new Map<PlaybackMark,number>();
  constructor(private readonly now:()=>number=()=>performance.now()){}
  mark(name:PlaybackMark,at=this.now()):void{
    if(!Number.isFinite(at))throw new Error('Invalid playback timestamp');
    if(this.marks.has(name))throw new Error('Duplicate playback mark');
    const previous=[...this.marks.values()].at(-1);
    if(previous!==undefined&&at<previous)throw new Error('Playback marks must be monotonic');
    this.marks.set(name,at);
  }
  summary():PlaybackMetric{
    const warming=this.marks.get('warming');
    const ready=this.marks.get('cells-ready');
    const first=this.marks.get('first-frame-sent');
    const final=this.marks.get('final-frame-sent');
    return{
      ...(warming!==undefined&&ready!==undefined?{warmupMs:ready-warming}:{}),
      ...(ready!==undefined&&first!==undefined?{startMs:first-ready}:{}),
      ...(first!==undefined&&final!==undefined?{playbackMs:final-first}:{}),
      ...(ready!==undefined&&final!==undefined?{totalStreamhubMs:final-ready}:{}),
    };
  }
}
