import {validateButtonActions} from './key-actions';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { ActionRegistry, type ActionDefinition } from './actions';
import { validatePageConfig, validatePageSources, type PageConfig } from '../../streamdeck/pages';

export type SourceConfig = { token: string; allowedHosts?: string[] };
export type AuthConfig = { adminToken: string; sources: Record<string, SourceConfig> };
export type DisplayMode = 'off' | 'hid' | 'plugin';
export type DisplayConfig = { mode: DisplayMode; plugin?: { port: number; tokenFile: string } };
export type Config = AuthConfig & {
  port: number;
  display: DisplayConfig;
  streamdeck?: { enabled: boolean; board?: PageConfig };
  streamdeckPlugin?: {enabled:boolean;port:number;tokenFile:string};
  actions?: Record<string, ActionDefinition>;
  collectors?: Array<{ source: string; exec: string[]; intervalMs: number; timeoutMs?: number }>;
};
export const configPath = () => resolve(process.env.STREAMHUB_CONFIG ?? '.streamhub/config.json');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && !item.includes('\0'));
const pluginSettings = (value: unknown): {port:number;tokenFile:string}|undefined => {
  if(value===undefined)return;
  if(!record(value)||typeof value.enabled!=='boolean'||!Number.isInteger(value.port)||(value.port as number)<1||(value.port as number)>65535||typeof value.tokenFile!=='string'||!isAbsolute(value.tokenFile)||Object.keys(value).some(key=>!['enabled','port','tokenFile'].includes(key)))throw new Error('Invalid streamdeckPlugin config');
  return{port:value.port as number,tokenFile:value.tokenFile};
};

export function configuredDisplay(config:Config):DisplayConfig{return structuredClone(config.display);}

/** Shared by file loading and standalone HTTP server construction. */
export function validateAuthConfig(input: unknown): asserts input is AuthConfig {
  if (!record(input) || !record(input.sources)) throw new Error('Invalid host config');
  const tokens: unknown[] = [input.adminToken];
  for (const [name, source] of Object.entries(input.sources)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid source name');
    if (!record(source) || (source.allowedHosts !== undefined && !strings(source.allowedHosts))) throw new Error('Invalid source config');
    tokens.push(source.token);
  }
  if (tokens.some(token => typeof token !== 'string' || token.length < 32) || new Set(tokens).size !== tokens.length) throw new Error('Distinct tokens of at least 32 characters are required');
}

/** Validate all startup configuration without opening devices, files or sockets. */
export function validateConfig(input: unknown): Config {
  validateAuthConfig(input);
  let config = input as AuthConfig & Record<string, unknown>;
  if (!Number.isInteger(config.port) || (config.port as number) < 1 || (config.port as number) > 65535) throw new Error('Invalid host port');
  if (config.streamdeck !== undefined) {
    if (!record(config.streamdeck) || typeof config.streamdeck.enabled !== 'boolean' || Object.keys(config.streamdeck).some(key => !['enabled','board'].includes(key))) throw new Error('Invalid streamdeck config');
    if (config.streamdeck.board !== undefined) {
      const board = validatePageConfig(config.streamdeck.board);
      validatePageSources(board,Object.keys(config.sources));
    }
  }
  const legacyPlugin=pluginSettings(config.streamdeckPlugin),legacyHid=record(config.streamdeck)&&config.streamdeck.enabled===true,legacyPluginEnabled=record(config.streamdeckPlugin)&&config.streamdeckPlugin.enabled===true;
  let display:DisplayConfig;
  if(config.display!==undefined){
    if(!record(config.display)||Object.keys(config.display).some(key=>!['mode','plugin'].includes(key))||!['off','hid','plugin'].includes(config.display.mode as string))throw new Error('Invalid display config');
    let plugin=legacyPlugin;
    if(config.display.plugin!==undefined){
      const raw=config.display.plugin;
      if(!record(raw)||Object.keys(raw).some(key=>!['port','tokenFile'].includes(key)))throw new Error('Invalid display config');
      plugin=pluginSettings({enabled:true,...raw});
    }
    if(config.display.mode==='plugin'&&!plugin)throw new Error('Invalid display config');
    display={mode:config.display.mode as DisplayMode,...(plugin?{plugin}:{})};
  }else{
    if(legacyHid&&legacyPluginEnabled)throw new Error('Display ownership is ambiguous');
    display={mode:legacyHid?'hid':legacyPluginEnabled?'plugin':'off',...(legacyPlugin?{plugin:legacyPlugin}:{})};
  }
  const legacyBoard=record(config.streamdeck)?config.streamdeck.board:undefined;
  config={...config,display,
    ...(config.streamdeck!==undefined||display.mode==='hid'?{streamdeck:{enabled:display.mode==='hid',...(legacyBoard===undefined?{}:{board:legacyBoard})}}:{}),
    ...(display.plugin?{streamdeckPlugin:{enabled:display.mode==='plugin',...display.plugin}}:{}),
  };
  if (config.actions !== undefined) {
    if (!record(config.actions)) throw new Error('Invalid actions');
    for (const action of Object.values(config.actions)) {
      if (!record(action) || !strings(action.exec) || !record(action.args) || !strings(action.sources)) throw new Error('Invalid action config');
      if (Object.values(action.args).some(pattern => typeof pattern !== 'string')) throw new Error('Invalid action argument patterns');
      if (action.sources.some(source => !Object.hasOwn(config.sources, source))) throw new Error('Actions require registered sources');
      if (action.cwd !== undefined && (typeof action.cwd !== 'string' || !action.cwd || action.cwd.includes('\0'))) throw new Error('Invalid action cwd');
      if (action.env !== undefined) {
        if (!record(action.env) || Object.entries(action.env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0'))) throw new Error('Invalid action environment');
      }
    }
    // Reuse the executable, template, regex and execution-limit contract.
    new ActionRegistry(config.actions as Record<string, ActionDefinition>);
  }
  if (config.collectors !== undefined && !Array.isArray(config.collectors)) throw new Error('Invalid collectors');
  const collected = new Set<string>();
  for (const collector of (config.collectors ?? []) as unknown[]) {
    if (!record(collector) || typeof collector.source !== 'string' || !Object.hasOwn(config.sources, collector.source) || collected.has(collector.source) || !Number.isInteger(collector.intervalMs) || (collector.intervalMs as number) < 1000 || (collector.intervalMs as number) > 3600000) throw new Error('Collectors require unique registered source and intervalMs between 1000 and 3600000');
    if (!strings(collector.exec)) throw new Error('Invalid collector executable');
    new ActionRegistry({ collect: { exec: collector.exec, args: {}, sources: [collector.source], timeoutMs: collector.timeoutMs as number | undefined, maxOutputBytes: 1048576 } });
    collected.add(collector.source);
  }
  if (config.streamdeck && (config.streamdeck as Config['streamdeck'])?.board) validateButtonActions((config.streamdeck as NonNullable<Config['streamdeck']>).board!, config.actions as Config['actions']);
  return config as Config;
}

function defaults(): Config {
  return { port: 31415, adminToken: randomUUID() + randomUUID(), sources: { demo: { token: randomUUID() + randomUUID() } },display:{mode:'off'} };
}
function load(path: string): Config { return validateConfig(JSON.parse(readFileSync(path, 'utf8'))); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** Publish a complete, private file; initialization never overwrites an existing config. */
function save(path: string, config: Config, exclusive: boolean): void {
  const contents = JSON.stringify(validateConfig(config), null, 2) + '\n';
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    if (exclusive) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
export function readConfig(initialize = false): Config {
  const path = configPath();
  try { return load(path); }
  catch (error) { if (!initialize || !missing(error)) throw error; }
  try { save(path, defaults(), true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return load(path);
}

/** Mutators receive the entire config so spreading it preserves extension settings. */
export function updateConfig(mutator: (config: Config) => Config): Config {
  const path = configPath();
  let current: Config;
  let initialize = false;
  try { current = load(path); }
  catch (error) {
    if (!missing(error)) throw error;
    current = defaults();
    initialize = true;
  }
  const updated = validateConfig(mutator(current));
  save(path, updated, initialize);
  return updated;
}
