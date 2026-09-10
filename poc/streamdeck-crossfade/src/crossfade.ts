export type PageId = 'a' | 'b';

export type CanvasGeometry = {
  columns: number;
  rows: number;
  keySize: number;
};

export function transitionFrameIndexes(currentPage: PageId, lastFrameIndex: number) {
  if (!Number.isInteger(lastFrameIndex) || lastFrameIndex < 1) throw new Error('last frame index must be a positive integer');
  if (currentPage === 'a') {
    return {nextPage: 'b' as const, indexes: Array.from({length: lastFrameIndex}, (_, index) => index + 1)};
  }
  return {nextPage: 'a' as const, indexes: Array.from({length: lastFrameIndex}, (_, index) => lastFrameIndex - index - 1)};
}

export function cellViewport(index: number, geometry: CanvasGeometry) {
  const {columns, rows, keySize} = geometry;
  if (!Number.isInteger(index) || index < 0 || index >= columns * rows) throw new Error(`key ${index} is outside ${columns}x${rows} canvas`);
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {left: column * keySize, top: row * keySize, width: keySize, height: keySize, column, row};
}

export function blendRgba(from: Uint8Array, to: Uint8Array, progress: number): Uint8Array {
  if (from.length !== to.length) throw new Error('page buffers must be the same size');
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('progress must be between 0 and 1');
  return Uint8Array.from(from, (value, index) => Math.round(value + (to[index] - value) * progress));
}
