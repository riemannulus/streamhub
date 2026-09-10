import {mkdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {blendRgba} from './crossfade';
import type {StudioConfig} from './studio-config';
import {validateStudioConfig} from './studio-config';
import {renderStudioCanvas} from './studio-render';
import {streamDeckClassicGeometry, streamDeckClassicKeyViewport} from './streamdeck-classic-geometry';

export type LiveStudioState = {generation: string; lastFrameIndex: number; config: StudioConfig};

export async function publishStudioGeneration(_options: {
  directory: string;
  generation: string;
  background: Uint8Array;
  previous?: Uint8Array;
  config: StudioConfig;
}): Promise<LiveStudioState> {
  const {directory, generation, background} = _options;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(generation)) throw new Error('Invalid generation');
  const config = validateStudioConfig(_options.config);
  const lastFrameIndex = 6;
  const next = await renderStudioCanvas(background, config);
  const previous = _options.previous ?? next;
  if (previous.length !== next.length) throw new Error('Invalid previous canvas');
  const framesDirectory = join(directory, 'frames', generation);
  await mkdir(framesDirectory, {recursive: true});

  for (let frameIndex = 0; frameIndex <= lastFrameIndex; frameIndex += 1) {
    const rgba = Buffer.from(blendRgba(previous, next, frameIndex / lastFrameIndex));
    const frameDirectory = join(framesDirectory, String(frameIndex));
    await mkdir(frameDirectory, {recursive: true});
    await Promise.all(Array.from({length: 15}, async (_, keyIndex) => {
      const viewport = streamDeckClassicKeyViewport(keyIndex);
      await sharp(rgba, {raw: {width: streamDeckClassicGeometry.width, height: streamDeckClassicGeometry.height, channels: 4}})
        .extract({left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height})
        .png({compressionLevel: 6})
        .toFile(join(frameDirectory, `${keyIndex}.png`));
    }));
  }

  const state: LiveStudioState = {generation, lastFrameIndex, config};
  const temporary = join(directory, `live-${generation}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {flag: 'wx'});
  await rename(temporary, join(directory, 'live.json'));
  return state;
}
