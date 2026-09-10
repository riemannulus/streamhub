import {randomBytes, randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import sharp from 'sharp';
import {defaultStudioConfig, validateStudioConfig, type StudioConfig} from './studio-config';
import {publishStudioGeneration} from './studio-publish';
import {renderStudioCanvas} from './studio-render';

const bodyLimit = 8 * 1024 * 1024;

export async function startStudioServer(options: {root: string; web: string; port?: number}) {
  const studioDirectory = resolve(options.root, 'studio');
  const backgroundPath = resolve(studioDirectory, 'background.jpg');
  const settingsPath = resolve(studioDirectory, 'settings.json');
  const token = randomBytes(24).toString('hex');
  let background: Buffer<ArrayBufferLike> = await readFile(backgroundPath);
  let config: StudioConfig;
  try {
    config = validateStudioConfig(JSON.parse(await readFile(settingsPath, 'utf8')));
  } catch {
    config = defaultStudioConfig();
  }
  let currentCanvas = await renderStudioCanvas(background, config);
  let state = await publishStudioGeneration({
    directory: studioDirectory,
    generation: `g${Date.now()}`,
    background,
    config,
  });

  const headers = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  const json = (value: unknown, status = 200) => Response.json(value, {status, headers});
  const publish = async (nextConfig: StudioConfig, nextBackground: Buffer) => {
    const nextCanvas = await renderStudioCanvas(nextBackground, nextConfig);
    state = await publishStudioGeneration({
      directory: studioDirectory,
      generation: `g${Date.now()}-${randomUUID().slice(0, 8)}`,
      background: nextBackground,
      previous: currentCanvas,
      config: nextConfig,
    });
    await writeFile(settingsPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
    currentCanvas = nextCanvas;
    config = nextConfig;
    background = nextBackground;
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 31418,
    maxRequestBodySize: bodyLimit,
    async fetch(request, server) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;
      if (request.headers.get('host') !== `127.0.0.1:${server.port}`) return json({error: 'Forbidden'}, 403);
      if (request.headers.has('origin') && request.headers.get('origin') !== origin) return json({error: 'Forbidden'}, 403);
      if (url.pathname === '/api/bootstrap' && request.method === 'GET') return json({token, config, generation: state.generation});
      if (url.pathname === '/api/background' && request.method === 'GET') return new Response(Uint8Array.from(background).buffer, {headers: {...headers, 'Content-Type': 'image/jpeg'}});
      if (url.pathname.startsWith('/api/') && request.method !== 'GET') {
        if (request.headers.get('x-streamhub-studio') !== token) return json({error: 'Forbidden'}, 403);
        if (url.pathname === '/api/config' && request.method === 'POST') {
          try {
            const raw = await request.text();
            if (Buffer.byteLength(raw) > 64 * 1024) return json({error: '설정이 너무 큽니다.'}, 413);
            await publish(validateStudioConfig(JSON.parse(raw)), background);
            return json({config, generation: state.generation});
          } catch (error) {
            return json({error: `설정을 적용하지 못했습니다: ${String(error)}`}, 400);
          }
        }
        if (url.pathname === '/api/background' && request.method === 'POST') {
          try {
            const raw = Buffer.from(await request.arrayBuffer());
            if (!raw.length || raw.length > bodyLimit) return json({error: '이미지는 8MB 이하여야 합니다.'}, 413);
            const metadata = await sharp(raw).metadata();
            if (!metadata.width || !metadata.height || metadata.width * metadata.height > 16_000_000) throw new Error('이미지 크기를 확인하세요.');
            if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '')) throw new Error('PNG, JPEG, WebP만 사용할 수 있습니다.');
            const normalized = await sharp(raw).rotate().jpeg({quality: 92}).toBuffer();
            await publish(config, normalized);
            await writeFile(backgroundPath, normalized);
            return json({config, generation: state.generation});
          } catch (error) {
            return json({error: `배경을 적용하지 못했습니다: ${String(error)}`}, 400);
          }
        }
      }
      if (request.method !== 'GET') return json({error: 'Not found'}, 404);
      const files = new Map<string, readonly [string, string]>([
        ['/', ['index.html', 'text/html; charset=utf-8']],
        ['/style.css', ['style.css', 'text/css; charset=utf-8']],
        ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
      ] as const);
      const asset = files.get(url.pathname);
      if (!asset) return json({error: 'Not found'}, 404);
      return new Response(Bun.file(resolve(options.web, asset[0])), {headers: {...headers, 'Content-Type': asset[1]}});
    },
  });
  return {url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true)};
}
