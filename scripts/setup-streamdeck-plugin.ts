import {homedir} from 'node:os';import {join,resolve} from 'node:path';
import {setupDisplayMode,setupPluginFiles} from '../packages/release/setup';
export {setupPluginFiles};
if(import.meta.main){try{const result=await setupDisplayMode({mode:'plugin',packageRoot:resolve('.'),applicationSupport:join(homedir(),'Library','Application Support'),pluginSource:resolve('packages/streamdeck-plugin/com.streamhub.studio.sdPlugin')});console.log(result.guidance);}catch(error){console.error(error instanceof Error?error.message:'Stream Deck 플러그인 설정에 실패했습니다.');process.exitCode=1;}}
