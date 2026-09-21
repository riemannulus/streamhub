import {afterEach,expect,test} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {defaultStudioDocument,singlePressBehavior,validateStudioDocument} from '../packages/studio/document';
import {StudioRepository} from '../packages/studio/repository';
import type {ProcessRequest} from '../packages/actions/system';
import {registerCrepeGitHubActions} from './register-crepe-github-actions';

const previous=process.env.STREAMHUB_CONFIG,directories:string[]=[];
afterEach(()=>{if(previous===undefined)delete process.env.STREAMHUB_CONFIG;else process.env.STREAMHUB_CONFIG=previous;for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function setup(){const directory=mkdtempSync(join(tmpdir(),'streamhub-crepe-register-'));directories.push(directory);const config=join(directory,'config.json');process.env.STREAMHUB_CONFIG=config;writeFileSync(config,JSON.stringify({port:31415,adminToken:'a'.repeat(32),sources:{demo:{token:'b'.repeat(32)}},display:{mode:'off'},future:{keep:true}}));return{directory,config,studio:join(directory,'studio')};}
const fakeDependencies=()=>{const calls:ProcessRequest[]=[];return{calls,dependencies:{which:()=>'/opt/homebrew/bin/gh',runProcess:async(request:ProcessRequest)=>{calls.push(structuredClone(request));return{stdout:'',stderr:'',exitCode:0};}}};};

test('registration preserves config and Studio content while adding one reachable release page',async()=>{
  const paths=setup(),repository=new StudioRepository(paths.studio),snapshot=repository.snapshot(),document=structuredClone(snapshot.document);document.pages.push({id:'tools',title:'Tools',buttons:[{id:'tool',index:0,behavior:singlePressBehavior({type:'open-url',url:'https://example.com'}),appearance:{contentMode:'hidden'}}]});repository.apply(document,snapshot.version);writeFileSync(join(paths.studio,'draft.json'),JSON.stringify(document));
  const fake=fakeDependencies(),result=await registerCrepeGitHubActions(fake.dependencies),config=JSON.parse(readFileSync(paths.config,'utf8')),context={pipelines:[{id:'crepe-backend-stg'},{id:'crepe-backend-prod'}]},applied=validateStudioDocument(JSON.parse(readFileSync(join(paths.studio,'studio.json'),'utf8')),context),draft=validateStudioDocument(JSON.parse(readFileSync(join(paths.studio,'draft.json'),'utf8')),context);
  expect(result).toMatchObject({gh:'/opt/homebrew/bin/gh',pageId:'crepe-release',draftUpdated:true});expect(config.adminToken).toBe('a'.repeat(32));expect(config.sources.demo.token).toBe('b'.repeat(32));expect(config.future).toEqual({keep:true});expect(config.githubActions.pipelines).toHaveLength(2);
  const page=applied.pages.find(item=>item.id==='crepe-release')!;expect(page.buttons?.map(button=>button.appearance.label?.text)).toEqual(['RC 컷','Stg 배포','Prod 승격','Prod 배포','이전 페이지']);expect(draft.pages.find(item=>item.id==='crepe-release')).toBeDefined();
  expect(applied.pages.find(item=>item.id==='tools')?.buttons?.some(button=>button.behavior.press?.type==='single'&&button.behavior.press.action.type==='next-page')).toBe(true);
  const before=readFileSync(join(paths.studio,'studio.json'),'utf8');await registerCrepeGitHubActions(fake.dependencies);expect(readFileSync(join(paths.studio,'studio.json'),'utf8')).toBe(before);expect(fake.calls.every(call=>!call.argv.includes('workflow'))).toBe(true);
});

test('registration refuses missing auth and an unreachable conflicting page without mutation',async()=>{
  const paths=setup(),missing=fakeDependencies();await expect(registerCrepeGitHubActions({...missing.dependencies,which:()=>undefined})).rejects.toThrow('gh');expect(JSON.parse(readFileSync(paths.config,'utf8'))).not.toHaveProperty('githubActions');
  const repository=new StudioRepository(paths.studio),snapshot=repository.snapshot(),document=structuredClone(snapshot.document);document.pages.push({id:'crepe-release',title:'Someone else'});repository.apply(document,snapshot.version);const before=readFileSync(join(paths.studio,'studio.json'),'utf8'),fake=fakeDependencies();await expect(registerCrepeGitHubActions(fake.dependencies)).rejects.toThrow('crepe-release');expect(readFileSync(join(paths.studio,'studio.json'),'utf8')).toBe(before);
});

test('registration initializes missing state and leaves an invalid draft untouched',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'streamhub-crepe-empty-'));directories.push(directory);process.env.STREAMHUB_CONFIG=join(directory,'config.json');const draft=join(directory,'studio','draft.json');const fake=fakeDependencies();
  await registerCrepeGitHubActions(fake.dependencies);expect(existsSync(process.env.STREAMHUB_CONFIG)).toBe(true);expect(existsSync(join(directory,'studio','studio.json'))).toBe(true);
  writeFileSync(draft,'{broken');const before=readFileSync(draft,'utf8'),result=await registerCrepeGitHubActions(fake.dependencies);expect(result.draftUpdated).toBe(false);expect(readFileSync(draft,'utf8')).toBe(before);
});
