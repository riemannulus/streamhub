import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startEditorServer } from '../packages/editor/server';

const assetsDir = resolve('.streamhub/editor');
await mkdir(assetsDir, {recursive: true});
const build = await Bun.build({entrypoints: ['packages/editor/web/app.ts'], outdir: assetsDir, target: 'browser'});
if (!build.success) { console.error('Editor build failed:', build.logs); process.exit(1); }
await Promise.all(['index.html','style.css'].map(file => copyFile(`packages/editor/web/${file}`, resolve(assetsDir,file))));
const editor = startEditorServer({assetsDir});
console.log(editor.url);
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await editor.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
