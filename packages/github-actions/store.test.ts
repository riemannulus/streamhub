import {expect,test} from 'bun:test';
import {SignalStore} from '../host/src/store';
import {SignalStorePipelinePersistence} from './store';

test('pipeline state is isolated in view_state and invalid stored values are ignored',()=>{
  const store=new SignalStore(':memory:'),persistence=new SignalStorePipelinePersistence(store);
  persistence.save('crepe-backend-stg',{version:1,trigger:{id:12,url:'https://github.com/cookieplace/crepe/actions/runs/12',headSha:'a'.repeat(40),headBranch:'develop',createdAt:'2026-09-21T01:00:00Z',state:'running'},baselineReleaseIds:[1,2]});
  expect(persistence.load('crepe-backend-stg')).toMatchObject({trigger:{id:12,state:'running'},baselineReleaseIds:[1,2]});
  store.setViewState('github-actions/other',{version:99,token:'must-not-surface'});
  expect(persistence.load('other')).toBeUndefined();
  expect(store.getViewState('github-actions/crepe-backend-stg')).not.toHaveProperty('token');
  store.close();
});

test('persistence rejects credentials, foreign URLs and oversized baselines before writing',()=>{
  const store=new SignalStore(':memory:'),persistence=new SignalStorePipelinePersistence(store),base={version:1 as const};
  expect(()=>persistence.save('bad/id',base)).toThrow();
  expect(()=>persistence.save('valid',{...base,runUrl:'https://evil.example/run'} as any)).toThrow();
  expect(()=>persistence.save('valid',{...base,baselineReleaseIds:Array.from({length:31},(_,index)=>index+1)})).toThrow();
  expect(()=>persistence.save('valid',{...base,token:'secret'} as any)).toThrow();
  expect(store.getViewState('github-actions/valid')).toBeUndefined();store.close();
});
