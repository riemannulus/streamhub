import {describe,expect,test} from 'bun:test';
import {defaultStudioDocument,validateStudioDocument} from './document';

describe('StudioDocument v2',()=>{
  test('validates the complete visual and interaction model without mutation',()=>{
    const raw={...defaultStudioDocument(),pages:[{id:'home',title:'Home',appearance:{background:{assetId:'a'.repeat(64),fit:'cover'}},buttons:[{index:0,type:'app',bundleId:'org.mozilla.firefox',label:'Firefox',appearance:{iconAssetId:'b'.repeat(64),opacity:0}}],dynamicRegions:[{id:'claude',keys:[1,2,3],signals:{source:'claude'},order:'recent',overflow:'paginate',empty:'background'}]}]};
    const before=structuredClone(raw);
    expect(validateStudioDocument(raw,{sources:['claude'],assets:['a'.repeat(64),'b'.repeat(64)]})).toEqual(before as any);
    expect(raw).toEqual(before);
  });
  test('rejects old configs, unknown fields, bad references and overlaps',()=>{
    expect(()=>validateStudioDocument({defaultPage:'home',pages:[]})).toThrow();
    expect(()=>validateStudioDocument({...defaultStudioDocument(),extra:true})).toThrow('Unknown');
    const doc=defaultStudioDocument();doc.defaultPageId='missing';expect(()=>validateStudioDocument(doc)).toThrow('default');
    const overlap=defaultStudioDocument();overlap.pages[0].buttons=[{index:0,type:'text',label:'x'}];overlap.pages[0].dynamicRegions=[{id:'r',keys:[0],signals:{source:'x'},order:'recent',overflow:'paginate',empty:'background'}];
    expect(()=>validateStudioDocument(overlap)).toThrow('Overlapping');
  });
});
