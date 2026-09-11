import {packageVersion,releaseTarget} from './version';

export type ReleaseManifest={
  formatVersion:1;
  name:'streamhub';
  version:string;
  target:typeof releaseTarget;
  gitCommit:string;
  builtAt:string;
  bun:'1.4.0';
  studioSchema:3;
  pluginVersion:string;
  displayModes:readonly ['off','hid','plugin'];
};

type ManifestInput=Pick<ReleaseManifest,'gitCommit'|'builtAt'|'pluginVersion'>;
const fields=['formatVersion','name','version','target','gitCommit','builtAt','bun','studioSchema','pluginVersion','displayModes'];
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=()=>new Error('Invalid release manifest');

export function createReleaseManifest(input:ManifestInput):ReleaseManifest{
  return validateReleaseManifest({formatVersion:1,name:'streamhub',version:packageVersion,target:releaseTarget,gitCommit:input.gitCommit,builtAt:input.builtAt,bun:'1.4.0',studioSchema:3,pluginVersion:input.pluginVersion,displayModes:['off','hid','plugin']});
}

export function validateReleaseManifest(value:unknown):ReleaseManifest{
  if(!record(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key)))throw invalid();
  if(value.formatVersion!==1||value.name!=='streamhub'||value.version!==packageVersion||value.target!==releaseTarget||value.bun!=='1.4.0'||value.studioSchema!==3)throw invalid();
  if(typeof value.gitCommit!=='string'||!/^[a-f0-9]{40}$/.test(value.gitCommit))throw invalid();
  if(typeof value.builtAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.builtAt)||new Date(value.builtAt).toISOString()!==value.builtAt)throw invalid();
  if(typeof value.pluginVersion!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(value.pluginVersion))throw invalid();
  if(!Array.isArray(value.displayModes)||value.displayModes.length!==3||value.displayModes[0]!=='off'||value.displayModes[1]!=='hid'||value.displayModes[2]!=='plugin')throw invalid();
  return{formatVersion:1,name:'streamhub',version:packageVersion,target:releaseTarget,gitCommit:value.gitCommit,builtAt:value.builtAt,bun:'1.4.0',studioSchema:3,pluginVersion:value.pluginVersion,displayModes:['off','hid','plugin']};
}
