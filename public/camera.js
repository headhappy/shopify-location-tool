// A single active camera with generation guards prevents late callbacks crossing products.
export class Camera {
  constructor(){this.reader=null;this.box=null;this.generation=0;}
  async stop(){this.generation++;const reader=this.reader,box=this.box;this.reader=null;this.box=null;if(reader){try{await reader.stop();}catch{}try{reader.clear();}catch{}}if(box)box.innerHTML='';}
  async start(box,onCode,{continuous=false}={}){
    await this.stop();if(!globalThis.Html5Qrcode)throw new Error('Camera library unavailable. Use a USB scanner or type the barcode.');
    this.box=box;const reader=new globalThis.Html5Qrcode(box.id);this.reader=reader;const generation=this.generation;let decoding=false;
    try{await reader.start({facingMode:'environment'},{fps:8,qrbox:{width:250,height:180}},async text=>{if(generation!==this.generation||decoding)return;decoding=true;if(!continuous)await this.stop();try{await onCode(text);}finally{decoding=false;}});}catch(e){if(generation===this.generation)await this.stop();throw new Error(e?.message||'Camera permission denied or camera unavailable.');}
  }
}
