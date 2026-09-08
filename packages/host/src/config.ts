import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ActionDefinition } from './actions';
import type { SourceConfig } from './server';

export type Config = {
  port: number; adminToken: string; sources: Record<string, SourceConfig>;
  streamdeck?: { enabled:boolean };
  actions?: Record<string, ActionDefinition>;
  collectors?: Array<{ source: string; exec: string[]; intervalMs: number; timeoutMs?: number }>;
};
export const configPath = () => resolve(process.env.STREAMHUB_CONFIG ?? '.streamhub/config.json');
export function readConfig(initialize = false): Config {
  const path = configPath();
  if (initialize) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, JSON.stringify({ port: 31415, adminToken: crypto.randomUUID() + crypto.randomUUID(), sources: { demo: { token: crypto.randomUUID() + crypto.randomUUID() } } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const config: Config = JSON.parse(readFileSync(path, 'utf8'));
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !config.sources || typeof config.sources !== 'object' || Array.isArray(config.sources)) throw new Error('Invalid host config');
  for (const source of Object.values(config.sources)) {
    if (!source || typeof source.token !== 'string' || (source.allowedHosts && (!Array.isArray(source.allowedHosts) || source.allowedHosts.some(host => typeof host !== 'string')))) throw new Error('Invalid source config');
  }
  if (config.streamdeck !== undefined && (!config.streamdeck || typeof config.streamdeck.enabled !== 'boolean' || Object.keys(config.streamdeck).some(key=>key!=='enabled'))) throw new Error('Invalid streamdeck config');
  if (config.collectors !== undefined && !Array.isArray(config.collectors)) throw new Error('Invalid collectors');
  const collected = new Set<string>();
  for (const collector of config.collectors ?? []) {
    if (!Object.hasOwn(config.sources, collector.source) || collected.has(collector.source) || !Number.isInteger(collector.intervalMs) || collector.intervalMs < 1000 || collector.intervalMs > 3600000) throw new Error('Collectors require unique registered source and intervalMs between 1000 and 3600000');
    collected.add(collector.source);
  }
  return config;
}
