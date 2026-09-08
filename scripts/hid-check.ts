import { mkdirSync, writeFileSync } from 'node:fs';
import { listStreamDecks, openStreamDeck, type StreamDeckButtonControlDefinitionLcdFeedback } from '@elgato-stream-deck/node';
import { diagnosticKey } from '../packages/streamdeck/diagnostic';

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const keepPattern = args.includes('--keep-pattern');
const secondsArg = args.find(value => value.startsWith('--listen='));
const listenSeconds = secondsArg ? Number(secondsArg.slice('--listen='.length)) : 5;
if (!Number.isFinite(listenSeconds) || listenSeconds < 0 || listenSeconds > 60) throw new Error('--listen must be 0..60 seconds');
if (args.some(value => value !== '--list' && value !== '--keep-pattern' && !value.startsWith('--listen='))) throw new Error('Usage: bun run hid:check [--list] [--listen=30] [--keep-pattern]');
const devices = await listStreamDecks();
if (listOnly) {
  console.log(JSON.stringify(devices.map(({model,path}) => ({model,path})), null, 2));
  process.exit(0);
}
if (devices.length !== 1) throw new Error(`Expected exactly one Stream Deck, found ${devices.length}. Use --list.`);
const deck = await openStreamDeck(devices[0].path, { resetToLogoOnClose: false });
const errors: string[] = [];
const events: {edge:'down'|'up'; index:number; elapsedMs:number}[] = [];
const started = performance.now();
deck.on('error', error => { errors.push(String(error)); console.error('HID error:', String(error)); });
for (const edge of ['down','up'] as const) deck.on(edge, control => {
  if (control.type !== 'button') return;
  const event = {edge, index:control.index, elapsedMs:Math.round(performance.now()-started)};
  events.push(event);
  console.log(JSON.stringify({event:edge,key:control.index+1}));
});
try {
  const controls = deck.CONTROLS.filter((control): control is StreamDeckButtonControlDefinitionLcdFeedback => control.type === 'button' && control.feedbackType === 'lcd');
  if (controls.length !== 15 || controls.some(control => control.pixelSize.width !== 72 || control.pixelSize.height !== 72)) throw new Error('This diagnostic targets a 15-key, 72x72 Stream Deck');
  const firmware = await deck.getFirmwareVersion();
  const writes: {key:number; elapsedMs:number}[] = [];
  const writeStart = performance.now();
  for (const control of controls) {
    const image = diagnosticKey(control.index, control.pixelSize.width, control.pixelSize.height);
    const t = performance.now();
    await deck.fillKeyBuffer(control.index, image, {format:'rgb'});
    writes.push({key:control.index+1,elapsedMs:Number((performance.now()-t).toFixed(2))});
  }
  const totalWriteMs = Number((performance.now()-writeStart).toFixed(2));
  const firmwareAfter = await deck.getFirmwareVersion();
  if (firmwareAfter !== firmware) throw new Error('Firmware query changed unexpectedly after output');
  console.log(JSON.stringify({status:'written',model:deck.MODEL,firmware,keyCount:controls.length,pixels:'72x72',totalWriteMs,writes}));
  console.log('Display: 01–05 red band, 06–10 green band, 11–15 blue band; yellow marker at top-left. No actions are attached.');
  if (listenSeconds > 0) {
    console.log(`Listening for key input for ${listenSeconds}s; pressing keys only logs HID events.`);
    await new Promise<void>(resolve => {
      const stop = () => { clearTimeout(timer); process.off('SIGINT',stop); process.off('SIGTERM',stop); resolve(); };
      const timer = setTimeout(stop,listenSeconds*1000);
      process.on('SIGINT',stop); process.on('SIGTERM',stop);
    });
  }
  const report = {checkedAt:new Date().toISOString(),runtime:Bun.version,model:deck.MODEL,firmware,keyCount:controls.length,totalWriteMs,writes,events,errors,visualConfirmation:'requires human observation'};
  mkdirSync('.streamhub',{recursive:true,mode:0o700});
  writeFileSync('.streamhub/hid-check.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
  if (errors.length) throw new Error(`${errors.length} HID errors observed`);
  console.log('PASS: all image writes and post-write firmware read completed; report: .streamhub/hid-check.json');
} finally {
  try { if (!keepPattern) await deck.resetToLogo(); }
  finally { await deck.close(); }
}
