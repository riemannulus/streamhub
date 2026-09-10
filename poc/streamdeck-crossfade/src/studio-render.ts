import sharp from 'sharp';
import type {StudioConfig} from './studio-config';
import {streamDeckClassicGeometry, streamDeckClassicKeyViewport} from './streamdeck-classic-geometry';

const {width, height} = streamDeckClassicGeometry;
const escape = (value: string) => value.replace(/[<>&"']/g, character => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
}[character]!));

function firefoxButton(label: string, opacity: number): Buffer {
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, '0');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <defs><linearGradient id="fire" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ffea60"/><stop offset=".48" stop-color="#ff7139"/><stop offset="1" stop-color="#8c3cff"/></linearGradient></defs>
    <rect x="9" y="9" width="126" height="126" rx="24" fill="#101722${alpha}" stroke="#ffffff88" stroke-width="2"/>
    <circle cx="72" cy="59" r="31" fill="url(#fire)"/>
    <path d="M48 58c5 19 30 29 45 12-7 8-22 5-24-5-2-9 6-16 15-15-10-12-31-7-36 8z" fill="#4d35d7"/>
    <path d="M45 47c-2-14 10-24 20-27-5 7-5 13-1 18" fill="#ff9d32"/>
    <text x="72" y="116" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="17" font-weight="650" fill="white">${escape(label)}</text>
  </svg>`);
}

export async function renderStudioCanvas(background: Uint8Array, config: StudioConfig): Promise<Uint8Array> {
  const overlays = config.buttons.map(button => {
    const viewport = streamDeckClassicKeyViewport(button.cell);
    return {input: firefoxButton(button.label, button.opacity), left: viewport.left, top: viewport.top};
  });
  const canvas = sharp(background).rotate().resize(width, height, {fit: 'cover', position: 'centre'}).ensureAlpha();
  if (overlays.length) canvas.composite(overlays);
  return new Uint8Array(await canvas.raw().toBuffer());
}
