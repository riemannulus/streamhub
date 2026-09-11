import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import sharp from 'sharp';

const MAX_BYTES=8*1024*1024,MAX_PIXELS=16*1024*1024;
export async function normalizeVisualAsset(input:Uint8Array):Promise<Buffer>{
  if(!input.length||input.byteLength>MAX_BYTES)throw new Error('Asset exceeds 8MB input limit');
  let metadata:sharp.Metadata;try{metadata=await sharp(input,{animated:false,limitInputPixels:MAX_PIXELS}).metadata();}catch(error){if(String(error).toLowerCase().includes('pixel'))throw new Error('Asset exceeds pixel limit');throw new Error('Unsupported or invalid image');}
  if(!metadata.format||!['png','jpeg','webp','gif','tiff','avif','heif','svg'].includes(metadata.format))throw new Error('Unsupported image format');
  if(!metadata.width||!metadata.height||metadata.width*metadata.height>MAX_PIXELS)throw new Error('Asset exceeds pixel limit');
  return sharp(input,{animated:false,limitInputPixels:MAX_PIXELS}).rotate().png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
}
export class VisualAssetStore{
  readonly directory:string;
  constructor(directory:string){this.directory=directory;mkdirSync(directory,{recursive:true,mode:0o700});}
  private path(id:string){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid asset ID');return join(this.directory,`${id}.png`);}
  async put(input:Uint8Array):Promise<string>{
    const bytes=await normalizeVisualAsset(input);
    const id=createHash('sha256').update(bytes).digest('hex'),path=this.path(id),temporary=`${path}.${randomUUID()}.tmp`;
    try{writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});try{renameSync(temporary,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}finally{rmSync(temporary,{force:true});}
    return id;
  }
  async read(id:string):Promise<Buffer>{return readFileSync(this.path(id));}
  async has(id:string):Promise<boolean>{try{const s=statSync(this.path(id));return s.isFile();}catch{return false;}}
}
