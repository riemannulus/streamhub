import { mkdirSync, copyFileSync } from 'node:fs';
const result=await Bun.build({entrypoints:['packages/host/src/main.ts'],outdir:'dist/packages/host/src',target:'bun',packages:'external'});
if(!result.success){console.error(result.logs);process.exit(1);}
mkdirSync('dist/packages/host/native',{recursive:true});
copyFileSync('packages/host/native/session-monitor.swift','dist/packages/host/native/session-monitor.swift');
console.log('Built dist/packages/host/src/main.js with native monitor source. Runtime dependencies remain in node_modules.');
