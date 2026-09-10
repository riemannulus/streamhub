import {describe, expect, test} from 'bun:test';
import {blendRgba, cellViewport, transitionFrameIndexes} from './crossfade';

describe('transitionFrameIndexes', () => {
  test('moves from page A to the final page B frame without replaying A', () => {
    expect(transitionFrameIndexes('a', 6)).toEqual({
      nextPage: 'b',
      indexes: [1, 2, 3, 4, 5, 6],
    });
  });

  test('moves from page B back to the final page A frame', () => {
    expect(transitionFrameIndexes('b', 6)).toEqual({
      nextPage: 'a',
      indexes: [5, 4, 3, 2, 1, 0],
    });
  });
});

describe('blendRgba', () => {
  test('blends arbitrary page pixels at the midpoint', () => {
    expect([...blendRgba(new Uint8Array([0, 40, 200, 255]), new Uint8Array([255, 80, 100, 255]), 0.5)]).toEqual([
      128, 60, 150, 255,
    ]);
  });

  test('rejects page buffers with different sizes', () => {
    expect(() => blendRgba(new Uint8Array([0]), new Uint8Array([0, 1]), 0.5)).toThrow('same size');
  });
});

describe('cellViewport', () => {
  test('maps the last key in a 5 by 3 canvas to row-major coordinates', () => {
    expect(cellViewport(14, {columns: 5, rows: 3, keySize: 144})).toEqual({
      left: 576,
      top: 288,
      width: 144,
      height: 144,
      column: 4,
      row: 2,
    });
  });

  test('rejects a key outside the canvas', () => {
    expect(() => cellViewport(15, {columns: 5, rows: 3, keySize: 144})).toThrow('outside 5x3 canvas');
  });
});
