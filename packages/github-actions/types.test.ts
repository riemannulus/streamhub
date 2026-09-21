import {expect,test} from 'bun:test';
import {CREPE_PIPELINES,validatePipelineDefinitions} from './crepe';

test('Crepe definitions encode press RC, hold Prod and exact downstream contracts',()=>{
  const definitions=validatePipelineDefinitions(CREPE_PIPELINES);
  expect(definitions.map(item=>[item.id,item.trigger.gesture,item.deployment.workflow])).toEqual([
    ['crepe-backend-stg','press','release-backend.yaml'],
    ['crepe-backend-prod','hold','release-backend-prod.yaml'],
  ]);
  expect(definitions[0]!.trigger.inputs).toEqual({'force-bump':'auto'});
  expect(definitions[0]!.deployment.approvalEnvironment).toBe('stg-backend');
  expect(definitions[1]!.trigger.inputs).toEqual({});
});

test('definition validation rejects identities and executable fields outside the trusted grammar',()=>{
  const mutations:Array<(value:any[])=>void>=[
    value=>{value[1].id=value[0].id;},
    value=>{value[0].repository='cookieplace/crepe;rm';},
    value=>{value[0].trigger.workflow='../cut-rc.yaml';},
    value=>{value[0].chain.anchorStep='';},
    value=>{value[0].chain.tagPattern='*';},
    value=>{value[0].deployment.event='pull_request';},
    value=>{value[0].unknown=true;},
  ];
  for(const mutate of mutations){
    const value=structuredClone(CREPE_PIPELINES) as any[];mutate(value);
    expect(()=>validatePipelineDefinitions(value)).toThrow();
  }
});

test('accepted definitions are cloned and cannot be mutated through the input',()=>{
  const input=structuredClone(CREPE_PIPELINES);
  const accepted=validatePipelineDefinitions(input);
  (input[0] as any).trigger.inputs['force-bump']='major';
  expect(accepted[0]!.trigger.inputs).toEqual({'force-bump':'auto'});
});
