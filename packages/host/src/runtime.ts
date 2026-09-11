import {createKeyActionExecutor} from './key-actions';
import { join } from 'node:path';
import {readFileSync,statSync} from 'node:fs';
import { ActionRegistry } from './actions';
import { validateConfig, type Config } from './config';
import { Reconciler, type Membership } from './reconciler';
import { startServer, type ServerOptions } from './server';
import { SignalStore } from './store';
import type {DeckBackend} from '../../presentation/backend';
import {startPluginBackend} from './plugin-backend';
import {startHidBackend} from './hid-backend';
import {startPresentationCoordinator,type PresentationCoordinator} from './presentation';
import {startSessionMonitor,type SessionState} from './session-monitor';
import {startAppContextMonitor,type ApplicationContext} from './app-context';
import {FileButtonStateStore} from './button-state';

type Collector = NonNullable<Config['collectors']>[number];
type HostServer = { url: URL; stop(closeActiveConnections?: boolean): void | Promise<void> };
export type HostDependencies = {
  openStore(path: string): SignalStore;
  serve(options: ServerOptions): HostServer;
  hidBackend(options:{events:{key(event:{index:number;phase:'down'|'up';generation:string}):void;ready():void};onError(error:unknown):void}):Promise<DeckBackend>;
  pluginBackend(options:{port:number;token:string;events:{key(event:{index:number;phase:'down'|'up';generation:string}):void;ready():void};onError(error:unknown):void}):Promise<DeckBackend>;
  sessionMonitor(callback:(state:SessionState)=>void,options:{cacheDir:string}):Promise<{stop():Promise<void>}>;
  contextMonitor(callback:(context:ApplicationContext)=>void,options:{cacheDir:string}):Promise<{stop():Promise<void>}>;
  collect(collector: Collector): Promise<Membership>;
};
export type HostOptions = { signal?: AbortSignal; onError?: (error: unknown) => void; dependencies?: Partial<HostDependencies> };
export type HostRuntime = { url: URL; stop(): Promise<void> };
export type StudioDisplayStatus={configuredMode:'off'|'hid'|'plugin';activeMode:'off'|'hid'|'plugin';state:'off'|'connecting'|'ready'|'recovering'|'unavailable';restartRequired:boolean;message?:string};
const aborted = () => new DOMException('Host startup was cancelled', 'AbortError');

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Owns all host resources. The CLI only supplies configuration and process signals. */
export async function startHost(input: Config, directory: string, options: HostOptions = {}): Promise<HostRuntime> {
  const config = validateConfig(input);
  if (options.signal?.aborted) throw aborted();
  const controller = new AbortController();
  const dependencies = options.dependencies ?? {};
  const actions = new ActionRegistry(config.actions);
  const collectors = (config.collectors ?? []).map(collector => ({ collector, runner: new ActionRegistry({
    collect: { exec: collector.exec, args: {}, sources: [collector.source], timeoutMs: collector.timeoutMs ?? 5000, maxOutputBytes: 1048576 },
  }) }));
  let store: SignalStore | undefined;
  let server: HostServer | undefined;
  let backend:DeckBackend|undefined;
  let pendingBackend:Promise<DeckBackend>|undefined;
  let presentation:PresentationCoordinator|undefined;
  let presentationMonitor:{stop():Promise<void>}|undefined;
  let startupFailure:unknown;
  let closed = false;
  let stopping: Promise<void> | undefined;
  const timers: ReturnType<typeof setInterval>[] = [];
  const jobs = new Set<Promise<unknown>>();
  const report = (error: unknown) => { try { options.onError?.(error); } catch {} };
  const onAbort = () => { void stop().catch(report); };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  function stop(): Promise<void> {
    if (stopping) return stopping;
    closed = true;
    stopping = Promise.resolve().then(async () => {
      // The native compiler is bounded; retain ownership until its late monitor
      // handle has been acquired and disposed, rather than orphaning it on exit.
      let pendingFailure:unknown;
      if(pendingBackend){try{backend=await pendingBackend;}catch(error){pendingFailure=error;}}
      const results:PromiseSettledResult<unknown>[] = await Promise.allSettled([Promise.resolve().then(()=>presentationMonitor?.stop()),Promise.resolve().then(()=>presentation?.stop()),Promise.resolve().then(()=>backend?.stop())]);
      results.push(...await Promise.allSettled([Promise.resolve().then(() => server?.stop(true))]));
      results.push(...await Promise.allSettled([...jobs]));
      results.push(...await Promise.allSettled([Promise.resolve().then(() => store?.close())]));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
      // Cancellation can win the startup race before display cleanup rejects.
      // Preserve that later failure; only omit the original startup error or a
      // plain cancellation, which the caller already receives directly.
      if(pendingFailure!==undefined && pendingFailure!==startupFailure
        && !(pendingFailure instanceof DOMException && pendingFailure.name==='AbortError'))errors.unshift(pendingFailure);
      if (errors.length) throw new AggregateError(errors, 'Host cleanup failed');
    });
    for (const timer of timers) clearInterval(timer);
    options.signal?.removeEventListener('abort', onAbort);
    controller.abort();
    return stopping;
  }
  const checkCancelled = () => { if (closed || controller.signal.aborted) throw aborted(); };
  try {
    store = (dependencies.openStore ?? (path => new SignalStore(path)))(join(directory, 'state.sqlite'));
    checkCancelled();
    const reconciler = new Reconciler(store, actions, Object.fromEntries(Object.entries(config.sources).map(([source, value]) => [source, value.allowedHosts ?? []])));
    if(config.display.mode!=='off'){
      const events={key:(event:{index:number;phase:'down'|'up';generation:string})=>{void presentation?.key(event).catch(report);},ready:()=>{void presentation?.backendReady().catch(report);}};
      if(config.display.mode==='plugin'){
        const plugin=config.display.plugin!;const tokenStat=statSync(plugin.tokenFile);if(!tokenStat.isFile()||(tokenStat.mode&0o077)!==0)throw new Error('Plugin token file must be private');const token=readFileSync(plugin.tokenFile,'utf8').trim();if(token.length<32)throw new Error('Plugin token must be at least 32 characters');
        pendingBackend=(dependencies.pluginBackend??startPluginBackend)({port:plugin.port,token,onError:report,events});
      }else pendingBackend=(dependencies.hidBackend??startHidBackend)({onError:report,events});
      backend=await untilAborted(pendingBackend,controller.signal);
      checkCancelled();
      presentation=await startPresentationCoordinator({store,directory:join(directory,'studio'),backend,execute:createKeyActionExecutor(config.actions,{cacheDir:join(directory,'.streamhub/native/system-actions')}),buttonState:new FileButtonStateStore(directory)});
      const sessionMonitor=await(dependencies.sessionMonitor??startSessionMonitor)(state=>{void presentation?.locked(!state.active).catch(report);},{cacheDir:join(directory,'native')});
      const contextMonitor=await(dependencies.contextMonitor??startAppContextMonitor)(context=>{void presentation?.context(context).catch(report);},{cacheDir:join(directory,'native')});
      presentationMonitor={async stop(){const results=await Promise.allSettled([sessionMonitor.stop(),contextMonitor.stop()]);const errors=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);if(errors.length)throw new AggregateError(errors,'Presentation monitor cleanup failed');}};
    }
    const publicDisplay=():StudioDisplayStatus=>{if(config.display.mode==='off')return{configuredMode:'off',activeMode:'off',state:'off',restartRequired:false};const status=presentation?.status()??backend?.status();return{configuredMode:config.display.mode,activeMode:config.display.mode,state:status?.state??'connecting',restartRequired:false,...(status?.message?{message:status.message}:{})};};
    server = (dependencies.serve ?? startServer)({ store, port: config.port, adminToken: config.adminToken, sources: config.sources, actions, health: () => reconciler.health(), display:publicDisplay,...(presentation?{studio:{snapshot:()=>presentation!.snapshot(),apply:(document,expectedVersion)=>presentation!.apply(document,expectedVersion),status:publicDisplay}}:{}) });
    checkCancelled();
    for (const { collector, runner } of collectors) {
      const tick = () => {
        if (closed) return;
        try {
          reconciler.expireStale(collector.source, collector.intervalMs);
          const job = reconciler.run(collector.source, async () => {
            if (dependencies.collect) return dependencies.collect(collector);
            const result = await runner.run(collector.source, { type: 'action', name: 'collect', args: {} });
            return JSON.parse(result.stdout);
          });
          jobs.add(job);
          void job.then(() => jobs.delete(job), error => { jobs.delete(job); report(error); void stop().catch(report); });
        } catch (error) { report(error); void stop().catch(report); }
      };
      tick();
      checkCancelled();
      timers.push(setInterval(tick, collector.intervalMs));
    }
    return { url: server.url, stop };
  } catch (error) {
    startupFailure=error;
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Host startup and cleanup failed'); }
    throw error;
  }
}
