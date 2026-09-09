import { startSimulation } from './host';
import { ArtifactRecorder } from './artifacts';
import { renderKey } from '../streamdeck/render';
import { choosePage,validatePageConfig,type PageConfig } from '../streamdeck/pages';
import { until } from './scenarios';

export type DraftCheck={name:string;status:'pass'|'fail'|'skip';detail?:string};
/** Configuration-independent checks; no page names or physical button assumptions. */
export async function checkDraft(input:PageConfig,sources:string[],directory:string){
  const board=validatePageConfig(input),artifacts=new ArtifactRecorder(directory),checks:DraftCheck[]=[];
  const sim=await startSimulation({board,sources:sources.length?sources:['demo'],onEvent:event=>artifacts.record(event)});
  const painted=async(id:string,automatic=false)=>until(`page ${id} final output`,async()=>{
    const state=await sim.state(),snapshot=sim.snapshot(),frame=snapshot.frame;
    if(snapshot.standby||!state.display.inputEnabled||frame?.viewId!==id||state.display.pageId!==id||(automatic&&state.display.manual))return false;
    const bytes=await Promise.all(frame.keys.map(key=>renderKey(key,frame)));
    return bytes.every((value,index)=>snapshot.pixels[index]?.equals(value));
  });
  try{
    for(const source of sources)await sim.upsert({id:'draft-check',label:'검증 신호',level:'warn'},undefined,source);
    for(const page of board.pages){
      await sim.selectPage(page.id);await painted(page.id);
      await artifacts.screenshot(`page-${board.pages.indexOf(page)+1}`);
      checks.push({name:`${page.title}: 15키 최종 출력`,status:'pass'});
    }
    sim.setSession(false);await until('draft standby',()=>sim.snapshot().standby);
    sim.setSession(true);await painted(board.pages.at(-1)!.id);
    checks.push({name:'잠금·해제 복원',status:'pass'});
    if(!board.pages.some(page=>page.match))checks.push({name:'자동 전환',status:'skip',detail:'문맥 조건이 없는 구성입니다.'});
    else {
      await sim.auto();
      for(const page of board.pages.filter(page=>page.match)){
        const context={available:true,appBundleId:page.match!.appBundleId??null,windowTitle:page.match!.windowTitle?.value??'',displayId:page.match!.displayId??'unmatched-monitor'};
        sim.setContext(context.appBundleId,true,context);
        const expected=choosePage(board,context);
        if(!expected.target)throw new Error(expected.reason);
        await painted(expected.target,true);
      }
      checks.push({name:'문맥 조건 자동 전환',status:'pass'});
    }
  }catch(error){checks.push({name:'초안 검증',status:'fail',detail:String(error)});await artifacts.screenshot('failure');}
  finally{await sim.stop();}
  const result={passed:checks.every(check=>check.status!=='fail'),checks};
  await artifacts.finish(result);return result;
}
