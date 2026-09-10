import {expect, test} from 'bun:test';
import sharp from 'sharp';
import {defaultStudioConfig} from './studio-config';
import {renderStudioCanvas} from './studio-render';

test('renders the background as one canvas and composites the button only in its cell', async () => {
  const background = await sharp({
    create: {width: 960, height: 544, channels: 3, background: '#fff200'},
  }).jpeg().toBuffer();
  const plain = await renderStudioCanvas(background, {...defaultStudioConfig(), buttons: []});
  const withButton = await renderStudioCanvas(background, defaultStudioConfig());

  expect(plain).toHaveLength(960 * 544 * 4);
  const pixel = (buffer: Uint8Array, x: number, y: number) => Buffer.from(buffer.slice((y * 960 + x) * 4, (y * 960 + x) * 4 + 4));
  expect(pixel(withButton, 94, 82)).toEqual(pixel(plain, 94, 82));
  expect(pixel(withButton, 31, 276)).not.toEqual(pixel(plain, 31, 276));
});
