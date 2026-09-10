import {createKeyActionExecutor} from './key-actions';
import type {ButtonEffect} from '../../streamdeck';
import { join } from 'node:path';
import {readFileSync,statSync} from 'node:fs';
import { ActionRegistry } from './actions';
import { validateConfig, type Config } from './config';
import { Reconciler, type Membership } from './reconciler';
import { startServer, type ServerOptions } from './server';
import { SignalStore } from './store';
import type { PageConfig } from '../../streamdeck/pages';
import {startPluginGateway,type PluginGateway} from './plugin-gateway';
import {startPresentationService,type PresentationService} from './presentation';
import {startSessionMonitor} from './session-monitor';
import {startAppContextMonitor} from './app-context';
import {FileButtonStateStore} from './button-state';

type Collector = NonNullable<Config['collectors']>[number];
type HostServer = { url: URL; stop(closeActiveConnections?: boolean): void | Promise<void> };
type HostDisplay = { status(): unknown; stop(): Promise<void> };
export type HostDependencies = {
  openStore(path: string): SignalStore;
  serve(options: ServerOptions): HostServer;
  display(store: SignalStore, directory: string, options: { signal: AbortSignal; board?: PageConfig; execute:(effect:ButtonEffect,signal?:AbortSignal)=>Promise<void> }): Promise<HostDisplay>;
  collect(collector: Collector): Promise<Membership>;
};
export type HostOptions = { signal?: AbortSignal; onError?: (error: unknown) => void; dependencies?: Partial<HostDependencies> };
export type HostRuntime = { url: URL; stop(): Promise<void> };
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
  let display: HostDisplay | undefined;
  let pendingDisplay: Promise<HostDisplay> | undefined;
  let pluginGateway:PluginGateway|undefined;
  let presentation:PresentationService|undefined;
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
      if(pendingDisplay){try{display=await pendingDisplay;}catch(error){pendingFailure=error;}}
      const results:PromiseSettledResult<unknown>[] = await Promise.allSettled([Promise.resolve().then(() => display?.stop()),Promise.resolve().then(()=>presentationMonitor?.stop()),Promise.resolve().then(()=>presentation?.stop()),Promise.resolve().then(()=>pluginGateway?.stop())]);
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
    if(config.streamdeckPlugin?.enabled){
      const tokenStat=statSync(config.streamdeckPlugin.tokenFile);if(!tokenStat.isFile()||(tokenStat.mode&0o077)!==0)throw new Error('Plugin token file must be private');const token=readFileSync(config.streamdeckPlugin.tokenFile,'utf8').trim();if(token.length<32)throw new Error('Plugin token must be at least 32 characters');
      pluginGateway=startPluginGateway({port:config.streamdeckPlugin.port,token,onMessage:message=>{void presentation?.message(message).catch(report);},onConnection:connected=>{if(!connected)presentation?.disconnect();}});
      presentation=await startPresentationService({store,directory:join(directory,'studio'),gateway:pluginGateway,execute:createKeyActionExecutor(config.actions,{cacheDir:join(directory,'.streamhub/native/system-actions')}),buttonState:new FileButtonStateStore(directory)});
      const sessionMonitor=await startSessionMonitor(state=>{void presentation?.message({v:1,type:'lock',locked:!state.active}).catch(report);},{cacheDir:join(directory,'native')});
      const contextMonitor=await startAppContextMonitor(context=>{void presentation?.context(context).catch(report);},{cacheDir:join(directory,'native')});
      presentationMonitor={async stop(){const results=await Promise.allSettled([sessionMonitor.stop(),contextMonitor.stop()]);const errors=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);if(errors.length)throw new AggregateError(errors,'Presentation monitor cleanup failed');}};
    }
    server = (dependencies.serve ?? startServer)({ store, port: config.port, adminToken: config.adminToken, sources: config.sources, actions, health: () => reconciler.health(), display: () => presentation?.status()??display?.status(),...(presentation?{studio:presentation}:{}) });
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
    if (config.streamdeck?.enabled) {
      const factory = dependencies.display ?? (async (store, directory, options) => {
        const module = await import('./display');
        return module.startDisplay(store, directory, options);
      });
      pendingDisplay = factory(store, directory, { signal: controller.signal, board: config.streamdeck?.board, execute:createKeyActionExecutor(config.actions,{cacheDir:join(directory,'.streamhub/native/system-actions')}) });
      display=await untilAborted(pendingDisplay, controller.signal);
      checkCancelled();
    }
    return { url: server.url, stop };
  } catch (error) {
    startupFailure=error;
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Host startup and cleanup failed'); }
    throw error;
  }
}
