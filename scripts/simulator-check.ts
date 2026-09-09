import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { scenarios,runScenario,type ScenarioResult } from '../packages/simulator/scenarios';

let output=resolve('.streamhub/simulator',new Date().toISOString().replace(/[:.]/g,'-')),selected:string|undefined;
const args=process.argv.slice(2);
for(let i=0;i<args.length;i++){
  const argument=args[i];
  if(argument==='--list'){for(const scenario of scenarios)console.log(`${scenario.name}: ${scenario.description}`);process.exit(0);}
  if(argument==='--out'&&args[i+1]){output=resolve(args[++i]);continue;}
  if(argument==='--scenario'&&args[i+1]){selected=args[++i];continue;}
  console.error('Usage: bun run simulator:check [--scenario NAME] [--out DIRECTORY] [--list]');process.exit(2);
}
const selectedScenarios=scenarios.filter(scenario=>!selected||scenario.name===selected);
if(!selectedScenarios.length){console.error(`Unknown scenario: ${selected}`);process.exit(2);}
// Never overwrite a previous run's evidence, even when an output path is supplied.
await mkdir(output,{recursive:true});
const runDirectory=await mkdtemp(join(output,'run-'));
console.log(`시뮬레이션 결과: ${runDirectory}`);
const results:ScenarioResult[]=[];
const controller=new AbortController();
const cancel=()=>controller.abort();
process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
for(const scenario of selectedScenarios){
  if(controller.signal.aborted)break;
  const result=await runScenario(scenario,join(runDirectory,scenario.name),controller.signal);results.push(result);
  console.log(`${result.passed?'PASS':'FAIL'} ${result.name} (${result.durationMs}ms, ${result.keyWrites} key writes)${result.error?`: ${result.error}`:''}`);
}
const passed=!controller.signal.aborted&&results.every(result=>result.passed);
await writeFile(join(runDirectory,'summary.json'),JSON.stringify({passed,cancelled:controller.signal.aborted,scenarios:results},null,2)+'\n');
console.log('각 시나리오의 replay.html, trace.jsonl, PNG에서 출력 결과를 확인할 수 있습니다.');
process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
process.exitCode=passed?0:1;
