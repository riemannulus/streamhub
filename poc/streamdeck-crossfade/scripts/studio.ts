import {resolve} from 'node:path';
import {copyFile, mkdir} from 'node:fs/promises';
import {startStudioServer} from '../src/studio-server';

const root = resolve(import.meta.dir, '..');
const pluginRoot = resolve(root, 'com.streamhub.crossfade-poc.sdPlugin');
const web = resolve(root, '.studio-build');
await mkdir(web, {recursive: true});
const build = await Bun.build({entrypoints: [resolve(root, 'studio-web/app.ts')], outdir: web, target: 'browser'});
if (!build.success) {
  console.error(build.logs);
  process.exit(1);
}
await Promise.all(['index.html', 'style.css'].map(file => copyFile(resolve(root, 'studio-web', file), resolve(web, file))));
const server = await startStudioServer({root: pluginRoot, web});
console.log(`Streamhub Studio PoC: ${server.url}`);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
