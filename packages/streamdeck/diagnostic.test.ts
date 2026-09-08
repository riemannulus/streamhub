import { expect, test } from 'bun:test';
import { diagnosticKey } from './diagnostic';

const pixel = (image: Buffer, x: number, y: number, width = 72) => [...image.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

test('diagnostic produces tightly packed RGB at requested dimensions', () => {
  expect(diagnosticKey(0).length).toBe(72 * 72 * 3);
  expect(diagnosticKey(14, 96, 80).length).toBe(96 * 80 * 3);
});

test('only actual key indices and usable integral dimensions are accepted', () => {
  for (const index of [-1, 15, 1.5, NaN, Infinity]) expect(() => diagnosticKey(index)).toThrow();
  for (const [width, height] of [[0, 72], [72, 0], [12, 12], [72.5, 72], [Infinity, 72], [4096, 72]]) {
    expect(() => diagnosticKey(0, width, height)).toThrow();
  }
});

test('top band identifies each five-key physical row and stays above the number', () => {
  expect(pixel(diagnosticKey(0), 36, 2)).toEqual([230, 40, 40]);
  expect(pixel(diagnosticKey(5), 36, 2)).toEqual([40, 210, 70]);
  expect(pixel(diagnosticKey(10), 36, 2)).toEqual([35, 100, 245]);
  expect(pixel(diagnosticKey(0), 36, 70)).toEqual([0, 0, 0]);
});

test('yellow top-left marker makes horizontal and vertical reversal detectable', () => {
  const image = diagnosticKey(0);
  expect(pixel(image, 2, 2)).toEqual([255, 255, 0]);
  expect(pixel(image, 69, 2)).toEqual([230, 40, 40]);
  expect(pixel(image, 2, 69)).toEqual([0, 0, 0]);
});

test('two large white digits distinguish all fifteen one-based labels', () => {
  const images = Array.from({ length: 15 }, (_, index) => diagnosticKey(index));
  expect(new Set(images.map(image => image.toString('base64'))).size).toBe(15);
  // 01: left zero has a top-left stroke and an empty middle; right one has its central stroke.
  expect(pixel(images[0]!, 15, 24)).toEqual([255, 255, 255]);
  expect(pixel(images[0]!, 21, 36)).toEqual([0, 0, 0]);
  expect(pixel(images[0]!, 51, 36)).toEqual([255, 255, 255]);
});
