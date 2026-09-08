import { dirname, join } from 'node:path';
import { ActionRegistry } from './actions';
import { configPath, readConfig } from './config';
import { SignalStore } from './store';
import { startServer } from './server';
import { Reconciler } from './reconciler';
import type { startDisplay } from './display';

const config = readConfig(true);
const actions = new ActionRegistry(config.actions);
const collectors = (config.collectors ?? []).map(item => ({ ...item, runner: new ActionRegistry({ collect: { exec: item.exec, args: {}, sources: [item.source], timeoutMs: item.timeoutMs ?? 5000, maxOutputBytes: 1048576 } }) }));
const store = new SignalStore(join(dirname(configPath()), 'state.sqlite'));
const reconciler = new Reconciler(store, actions, Object.fromEntries(Object.entries(config.sources).map(([name, source]) => [name, source.allowedHosts ?? []])));
let display: Awaited<ReturnType<typeof startDisplay>>|undefined;
let displayStarting: Promise<void>|undefined;
let server: ReturnType<typeof startServer>;
try { server = startServer({ store, port: config.port, adminToken: config.adminToken, sources: config.sources, actions, health: () => reconciler.health(), display:()=>display?.status() }); }
catch (error) { store.close(); throw error; }
const jobs = new Set<Promise<unknown>>();
const timers = collectors.map(collector => {
  const tick = () => {
    reconciler.expireStale(collector.source, collector.intervalMs);
    const job = reconciler.run(collector.source, async () => {
      const result = await collector.runner.run(collector.source, { type: 'action', name: 'collect', args: {} });
      return JSON.parse(result.stdout);
    });
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  };
  tick();
  return setInterval(tick, collector.intervalMs);
});
console.log(`Streamhub listening on ${server.url}`);
console.log(`Config: ${configPath()} (tokens are not printed)`);
let stopping = false;
async function stop(exitCode=0) {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearInterval(timer);
  try { await displayStarting; } catch {}
  await display?.stop();
  await server.stop(true);
  await Promise.allSettled([...jobs]);
  store.close();
  process.exit(exitCode);
}
process.on('SIGINT', ()=>{void stop();});
process.on('SIGTERM', ()=>{void stop();});
process.on('uncaughtException', error=>{console.error(error);void stop(1);});
process.on('unhandledRejection', error=>{console.error(error);void stop(1);});
if(config.streamdeck?.enabled){
  displayStarting=import('./display').then(async module=>{display=await module.startDisplay(store,dirname(configPath()));});
  void displayStarting.catch(error=>{console.error('[display] initialization failed:',error);void stop(1);});
}
