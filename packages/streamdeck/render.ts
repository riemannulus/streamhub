import sharp from 'sharp';
import type { DeckKey, DeckPage } from './index';

const colors = { info:'#269d91', warn:'#dba52f', urgent:'#dc3741' };
const escape = (text:string) => text.replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]!));
const segmenter = new Intl.Segmenter(undefined,{granularity:'grapheme'});
const chars = (value:string) => [...segmenter.segment(value)].map(item=>item.segment);

/** Fixed-size, escaped SVG rasterized locally. No external resources or source-provided markup. */
export async function renderKey(key:DeckKey,page:DeckPage):Promise<Buffer> {
  if (key.type==='empty') return Buffer.alloc(72*72*3);
  let title='', subtitle='', foot='', color='#303945';
  if (key.type==='signal' || key.type==='pin') {
    if (key.record) {
      title=key.record.label;
      subtitle=key.type==='pin' ? 'PIN' : key.record.source;
      foot=key.record.freshness==='stale' ? 'STALE' : key.record.level.toUpperCase();
      color=key.record.freshness==='stale' ? '#666666' : colors[key.record.level];
      if(key.type==='pin' && key.hiddenCount) subtitle+=` +${key.hiddenCount}`;
    } else { title='PIN';foot='—'; }
  } else if(key.type==='tile'){
    title=key.label;subtitle=key.subtitle ?? '';foot=key.foot ?? '';
    color=key.enabled===false?'#24282e':key.color && /^#[0-9a-f]{6}$/i.test(key.color)?key.color:'#426087';
  } else {
    title=key.type==='previous'?'←':'→';
    subtitle=`${page.index+1}/${page.pageCount}`;
    foot=key.urgentCount ? `! ${key.urgentCount}` : '';
    color=key.urgentCount ? colors.urgent : key.enabled?'#426087':'#24282e';
  }
  const letters=chars(title);
  const line1=letters.slice(0,7).join('');
  const line2=letters.slice(7,13).join('')+(letters.length>13?'…':'');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72">
    <rect width="72" height="72" fill="#111820"/><rect width="72" height="7" fill="${color}"/>
    <g font-family="sans-serif" text-anchor="middle" fill="white">
    <text x="36" y="20" font-size="8" fill="#acbac9">${escape(chars(subtitle).slice(0,12).join(''))}</text>
    <text x="36" y="35" font-size="10">${escape(line1)}</text><text x="36" y="48" font-size="10">${escape(line2)}</text>
    <text x="36" y="65" font-size="8" fill="#d1dce8">${escape(foot)}</text></g></svg>`;
  return sharp(Buffer.from(svg)).flatten({background:'#000000'}).removeAlpha().raw().toBuffer();
}
