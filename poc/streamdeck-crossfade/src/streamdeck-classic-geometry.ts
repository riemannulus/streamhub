export const streamDeckClassicGeometry = {
  columns: 5,
  rows: 3,
  // Elgato's 480×272 Classic LCD pixel layout, doubled for 144px key images.
  width: 960,
  height: 544,
  keySize: 144,
  left: 22,
  top: 10,
  columnPitch: 194,
  rowPitch: 194,
} as const;

export function streamDeckClassicKeyViewport(index: number) {
  const geometry = streamDeckClassicGeometry;
  if (!Number.isInteger(index) || index < 0 || index >= geometry.columns * geometry.rows) {
    throw new Error(`key ${index} is outside ${geometry.columns}x${geometry.rows} canvas`);
  }
  const column = index % geometry.columns;
  const row = Math.floor(index / geometry.columns);
  return {
    left: geometry.left + column * geometry.columnPitch,
    top: geometry.top + row * geometry.rowPitch,
    width: geometry.keySize,
    height: geometry.keySize,
    column,
    row,
  };
}
