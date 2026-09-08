const DIGITS = [
  ['111', '101', '101', '101', '111'],
  ['010', '110', '010', '010', '111'],
  ['111', '001', '111', '100', '111'],
  ['111', '001', '111', '001', '111'],
  ['101', '101', '111', '001', '001'],
  ['111', '100', '111', '001', '111'],
  ['111', '100', '111', '101', '111'],
  ['111', '001', '010', '010', '010'],
  ['111', '101', '111', '101', '111'],
  ['111', '101', '111', '001', '111'],
] as const;
type RGB = readonly [number, number, number];
const ROW_COLORS: readonly RGB[] = [[230, 40, 40], [40, 210, 70], [35, 100, 245]];

/** RGB diagnostic image in top-left-origin row-major order; key index is zero-based. */
export function diagnosticKey(index: number, width = 72, height = 72): Buffer {
  if (!Number.isInteger(index) || index < 0 || index > 14) throw new RangeError('Key index must be 0–14');
  for (const dimension of [width, height]) {
    if (!Number.isInteger(dimension) || dimension < 24 || dimension > 512) {
      throw new RangeError('Image dimensions must be integers between 24 and 512');
    }
  }
  const image = Buffer.alloc(width * height * 3);
  const rectangle = (left: number, top: number, w: number, h: number, color: RGB) => {
    for (let y = top; y < top + h; y++) {
      for (let x = left; x < left + w; x++) {
        const offset = (y * width + x) * 3;
        image[offset] = color[0];
        image[offset + 1] = color[1];
        image[offset + 2] = color[2];
      }
    }
  };
  const band = Math.max(3, Math.floor(height / 9));
  rectangle(0, 0, width, band, ROW_COLORS[Math.floor(index / 5)]!);
  const marker = Math.max(3, Math.floor(Math.min(width, height) / 12));
  rectangle(0, 0, marker, marker, [255, 255, 0]);

  const scale = Math.max(1, Math.floor(Math.min(width / 9, height / 9)));
  const left = Math.floor((width - 7 * scale) / 2);
  const top = band + Math.floor((height - band - 5 * scale) / 2);
  const label = String(index + 1).padStart(2, '0');
  for (let digit = 0; digit < label.length; digit++) {
    const glyph = DIGITS[Number(label[digit])]!;
    glyph.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === '1') rectangle(left + (digit * 4 + x) * scale, top + y * scale, scale, scale, [255, 255, 255]);
      }
    });
  }
  return image;
}
