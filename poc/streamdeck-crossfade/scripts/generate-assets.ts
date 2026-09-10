import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import sharp from 'sharp';
import {blendRgba, cellViewport} from '../src/crossfade';

const pluginDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../com.streamhub.crossfade-poc.sdPlugin');
const frameDirectory = resolve(pluginDirectory, 'imgs/frames');
const columns = 5;
const rows = 3;
const keySize = 144;
const width = columns * keySize;
const height = rows * keySize;
const lastFrameIndex = 6;

const pageSvg = (page: 'a' | 'b') => page === 'a'
  ? `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#071827"/><stop offset="1" stop-color="#12465a"/></linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <circle cx="112" cy="104" r="74" fill="#2dd4bf" opacity=".88"/>
      <circle cx="620" cy="350" r="150" fill="#0ea5e9" opacity=".34"/>
      <text x="360" y="190" text-anchor="middle" font-family="Arial,sans-serif" font-size="70" font-weight="700" fill="#f8fafc">STREAMHUB</text>
      <text x="360" y="255" text-anchor="middle" font-family="Arial,sans-serif" font-size="26" letter-spacing="8" fill="#99f6e4">PAGE A</text>
      <text x="360" y="330" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="#bae6fd">PRESS ANY KEY</text>
    </svg>`
  : `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="1" y1="0" x2="0" y2="1"><stop stop-color="#3b0764"/><stop offset=".52" stop-color="#9d174d"/><stop offset="1" stop-color="#ea580c"/></linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <rect x="55" y="54" width="610" height="324" rx="54" fill="#13091d" opacity=".34" stroke="#fef3c7" stroke-width="3"/>
      <text x="360" y="188" text-anchor="middle" font-family="Arial,sans-serif" font-size="68" font-weight="700" fill="#fff7ed">CROSSFADE</text>
      <text x="360" y="255" text-anchor="middle" font-family="Arial,sans-serif" font-size="26" letter-spacing="8" fill="#fde68a">PAGE B</text>
      <text x="360" y="330" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="#ffedd5">PRESS TO RETURN</text>
    </svg>`;

async function rgba(svg: string): Promise<Uint8Array> {
  return new Uint8Array(await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer());
}

async function writeIconPair(pathWithoutExtension: string, sizes: [number, number], svg: string) {
  await mkdir(dirname(pathWithoutExtension), {recursive: true});
  await sharp(Buffer.from(svg)).resize(sizes[0], sizes[0]).png().toFile(`${pathWithoutExtension}.png`);
  await sharp(Buffer.from(svg)).resize(sizes[1], sizes[1]).png().toFile(`${pathWithoutExtension}@2x.png`);
}

await mkdir(frameDirectory, {recursive: true});
const [pageA, pageB] = await Promise.all([rgba(pageSvg('a')), rgba(pageSvg('b'))]);

for (let frameIndex = 0; frameIndex <= lastFrameIndex; frameIndex += 1) {
  const frame = Buffer.from(blendRgba(pageA, pageB, frameIndex / lastFrameIndex));
  const outputDirectory = resolve(frameDirectory, String(frameIndex));
  await mkdir(outputDirectory, {recursive: true});
  for (let keyIndex = 0; keyIndex < columns * rows; keyIndex += 1) {
    const viewport = cellViewport(keyIndex, {columns, rows, keySize});
    await sharp(frame, {raw: {width, height, channels: 4}})
      .extract({left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height})
      .png({compressionLevel: 6})
      .toFile(resolve(outputDirectory, `${keyIndex}.png`));
  }
}

const mark = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" rx="110" fill="#101827"/><path d="M92 154h328v68H92zm0 136h328v68H92z" fill="#2dd4bf"/><circle cx="172" cy="188" r="22" fill="#fff"/><circle cx="340" cy="324" r="22" fill="#fff"/></svg>`;
const mono = `<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg"><rect x="20" y="30" width="104" height="30" rx="8" fill="#fff"/><rect x="20" y="84" width="104" height="30" rx="8" fill="#fff"/></svg>`;
const defaultKey = `<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg"><rect width="144" height="144" fill="#101827"/><path d="M26 44h92v22H26zm0 36h92v22H26z" fill="#2dd4bf"/></svg>`;

await Promise.all([
  writeIconPair(resolve(pluginDirectory, 'imgs/plugin/marketplace'), [256, 512], mark),
  writeIconPair(resolve(pluginDirectory, 'imgs/plugin/category'), [28, 56], mono),
  writeIconPair(resolve(pluginDirectory, 'imgs/actions/canvas/icon'), [20, 40], mono),
  writeIconPair(resolve(pluginDirectory, 'imgs/actions/canvas/key'), [72, 144], defaultKey),
]);

console.log(`Generated ${lastFrameIndex + 1} frames × ${columns * rows} cells in ${frameDirectory}`);
