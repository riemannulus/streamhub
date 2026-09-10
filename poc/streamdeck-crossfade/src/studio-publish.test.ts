import {expect, test} from 'bun:test';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {defaultStudioConfig} from './studio-config';
import {publishStudioGeneration} from './studio-publish';

test('publishes all transition cells before exposing the live generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'streamhub-studio-'));
  try {
    const red = Buffer.from('<svg width="16" height="16" xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" fill="#ff0000"/></svg>');
    const blue = Buffer.from('<svg width="16" height="16" xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" fill="#0000ff"/></svg>');
    const background = await sharp({create: {width: 960, height: 544, channels: 3, background: '#000000'}})
      .composite([{input: red, left: 86, top: 74}, {input: blue, left: 862, top: 462}])
      .png()
      .toBuffer();
    const config = {...defaultStudioConfig(), buttons: []};
    const result = await publishStudioGeneration({directory, generation: 'test-1', background, previous: undefined, config});

    expect(result).toEqual({generation: 'test-1', lastFrameIndex: 6, config});
    expect(JSON.parse(await readFile(join(directory, 'live.json'), 'utf8'))).toEqual(result);
    expect((await stat(join(directory, 'frames', 'test-1', '6', '14.png'))).size).toBeGreaterThan(100);
    const first = await sharp(join(directory, 'frames', 'test-1', '6', '0.png')).raw().toBuffer();
    const last = await sharp(join(directory, 'frames', 'test-1', '6', '14.png')).raw().toBuffer();
    const centre = (pixels: Buffer) => [...pixels.subarray((72 * 144 + 72) * 4, (72 * 144 + 72) * 4 + 3)];
    expect(centre(first)).toEqual([255, 0, 0]);
    expect(centre(last)).toEqual([0, 0, 255]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
