import type {PipelineDefinition} from './types';

export const CREPE_PIPELINES:readonly PipelineDefinition[]=[
  {id:'crepe-backend-stg',repository:'cookieplace/crepe',ref:'develop',trigger:{workflow:'cut-rc.yaml',inputs:{'force-bump':'auto'},gesture:'press'},chain:{kind:'tag-push',anchorJob:'cut-rc',anchorStep:'Push rc tag',tagPattern:'backend/v*.*.*-rc.*'},deployment:{workflow:'release-backend.yaml',event:'push',approvalEnvironment:'stg-backend'}},
  {id:'crepe-backend-prod',repository:'cookieplace/crepe',ref:'develop',trigger:{workflow:'backend-release-cut-prod.yaml',inputs:{},gesture:'hold'},chain:{kind:'release-published',anchorJob:'cut-release',anchorStep:'Create release',tagPattern:'backend/v*.*.*'},deployment:{workflow:'release-backend-prod.yaml',event:'release'}},
];

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:readonly string[])=>{if(Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Unknown pipeline field');};
const bounded=(value:unknown,label:string,max=128)=>{if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new Error(`Invalid ${label}`);return value;};
const identifier=(value:unknown,label:string)=>{const result=bounded(value,label,64);if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result))throw new Error(`Invalid ${label}`);return result;};
const repository=(value:unknown)=>{const result=bounded(value,'repository',200);if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result))throw new Error('Invalid repository');return result;};
const ref=(value:unknown)=>{const result=bounded(value,'ref',255);if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(result)||result.includes('..')||result.includes('//')||result.endsWith('/'))throw new Error('Invalid ref');return result;};
const workflow=(value:unknown)=>{const result=bounded(value,'workflow',128);if(!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(result))throw new Error('Invalid workflow');return result;};
const tagPattern=(value:unknown)=>{const result=bounded(value,'tag pattern',128);if(!result.startsWith('backend/v')||!result.includes('*')||!/^[A-Za-z0-9._/*-]+$/.test(result))throw new Error('Invalid tag pattern');return result;};

export function validatePipelineDefinitions(input:unknown):PipelineDefinition[]{
  if(!Array.isArray(input)||input.length<1||input.length>16)throw new Error('Expected 1–16 pipeline definitions');
  const ids=new Set<string>();
  return input.map(raw=>{
    if(!record(raw))throw new Error('Invalid pipeline definition');exact(raw,['id','repository','ref','trigger','chain','deployment']);
    const id=identifier(raw.id,'pipeline ID');if(ids.has(id))throw new Error('Duplicate pipeline ID');ids.add(id);
    if(!record(raw.trigger))throw new Error('Invalid trigger');exact(raw.trigger,['workflow','inputs','gesture']);
    if(!record(raw.trigger.inputs)||Object.keys(raw.trigger.inputs).length>16)throw new Error('Invalid workflow inputs');
    const inputs:Record<string,string>={};
    for(const [key,value] of Object.entries(raw.trigger.inputs)){
      if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)||typeof value!=='string'||value.length>512||value.includes('\0'))throw new Error('Invalid workflow inputs');
      inputs[key]=value;
    }
    if(raw.trigger.gesture!=='press'&&raw.trigger.gesture!=='hold')throw new Error('Invalid trigger gesture');
    if(!record(raw.chain))throw new Error('Invalid pipeline chain');exact(raw.chain,['kind','anchorJob','anchorStep','tagPattern']);
    if(raw.chain.kind!=='tag-push'&&raw.chain.kind!=='release-published')throw new Error('Invalid pipeline chain');
    if(!record(raw.deployment))throw new Error('Invalid deployment');exact(raw.deployment,['workflow','event','approvalEnvironment']);
    if(raw.deployment.event!=='push'&&raw.deployment.event!=='release')throw new Error('Invalid deployment event');
    if((raw.chain.kind==='tag-push')!==(raw.deployment.event==='push'))throw new Error('Pipeline chain and event do not match');
    const approvalEnvironment=raw.deployment.approvalEnvironment===undefined?undefined:identifier(raw.deployment.approvalEnvironment,'approval environment');
    return{
      id,repository:repository(raw.repository),ref:ref(raw.ref),
      trigger:{workflow:workflow(raw.trigger.workflow),inputs,gesture:raw.trigger.gesture},
      chain:{kind:raw.chain.kind,anchorJob:identifier(raw.chain.anchorJob,'anchor job'),anchorStep:bounded(raw.chain.anchorStep,'anchor step'),tagPattern:tagPattern(raw.chain.tagPattern)},
      deployment:{workflow:workflow(raw.deployment.workflow),event:raw.deployment.event,...(approvalEnvironment?{approvalEnvironment}:{})},
    };
  });
}
