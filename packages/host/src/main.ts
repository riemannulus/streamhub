import { dirname } from 'node:path';
import { configPath, readConfig } from './config';
import { startHost, type HostRuntime } from './runtime';
import { AlreadyRunningError } from './store';

const controller = new AbortController();
let runtime: HostRuntime | undefined;
let exitCode = 0;
let stopping: Promise<void> | undefined;
let starting: Promise<HostRuntime> | undefined;
function report(error: unknown) {
  if (error instanceof AlreadyRunningError) {
    console.error('Streamhub가 이미 실행 중입니다. 기존 호스트를 사용하거나 종료한 뒤 다시 시작하세요.');
  } else console.error(error);
}
function stop(code = 0): Promise<void> {
  exitCode = Math.max(exitCode, code);
  if (stopping) return stopping;
  stopping = Promise.resolve().then(async () => {
    try { runtime = await starting; } catch {}
    try { await runtime?.stop(); } catch (error) { report(error); exitCode = 1; }
    process.exit(exitCode);
  });
  controller.abort();
  return stopping;
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('uncaughtException', error => { report(error); void stop(1); });
process.on('unhandledRejection', error => { report(error); void stop(1); });
try {
  starting = startHost(readConfig(true), dirname(configPath()), { signal: controller.signal, onError: error => { report(error); void stop(1); } });
  runtime = await starting;
  if (!controller.signal.aborted) {
    console.log(`Streamhub listening on ${runtime.url}`);
    console.log(`Config: ${configPath()} (tokens are not printed)`);
  }
} catch (error) {
  if (!(controller.signal.aborted && error instanceof DOMException && error.name === 'AbortError')) {
    report(error);
    exitCode = 1;
  }
  await stop(exitCode);
}
