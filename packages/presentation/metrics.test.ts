import {describe,expect,test} from 'bun:test';
import {PlaybackRecorder} from './metrics';

describe('PlaybackRecorder',()=>{
  test('separates external warmup from Streamhub restore time',()=>{
    const recorder=new PlaybackRecorder(()=>1000);
    recorder.mark('warming');
    recorder.mark('cells-ready',4100);
    recorder.mark('first-frame-sent',4180);
    recorder.mark('final-frame-sent',4550);

    expect(recorder.summary()).toEqual({warmupMs:3100,startMs:80,playbackMs:370,totalStreamhubMs:450});
  });

  test('rejects duplicate, non-finite and out-of-order marks',()=>{
    const recorder=new PlaybackRecorder(()=>100);
    recorder.mark('warming');
    expect(()=>recorder.mark('warming',101)).toThrow('Duplicate playback mark');
    expect(()=>recorder.mark('cells-ready',Number.NaN)).toThrow('Invalid playback timestamp');
    expect(()=>recorder.mark('cells-ready',99)).toThrow('Playback marks must be monotonic');
  });

  test('returns only durations supported by the marks received so far',()=>{
    const recorder=new PlaybackRecorder(()=>10);
    recorder.mark('cells-ready');
    recorder.mark('first-frame-sent',25);
    expect(recorder.summary()).toEqual({startMs:15});
  });
});
