import type {StudioModel} from './model';
import {pageReferences} from '../editing';

type Callbacks={standby:boolean;select(pageId:string):void;selectStandby():void;changed():void;error(message:string):void};
const iconButton=(label:string,title:string,onClick:()=>void)=>{const button=document.createElement('button');button.type='button';button.className='icon-button';button.textContent=label;button.title=title;button.onclick=event=>{event.stopPropagation();onClick();};return button;};

export function renderPages(container:HTMLElement,model:StudioModel,callbacks:Callbacks):void{
  container.replaceChildren();
  model.document.pages.forEach((page,index)=>{
    const row=document.createElement('div');row.className='page-row'+(!callbacks.standby&&page.id===model.selectedPageId?' selected':'');row.onclick=()=>callbacks.select(page.id);
    const grip=document.createElement('span');grip.className='page-grip';grip.textContent='⠿';const name=document.createElement('input');name.value=page.title;name.setAttribute('aria-label','페이지 이름');name.style.cssText='width:100%;min-width:0;padding:5px 4px;border:0;background:transparent;color:#e9eff6;font-weight:650';name.onclick=event=>event.stopPropagation();name.onchange=()=>{try{model.renamePage(page.id,name.value);callbacks.changed();}catch(error){callbacks.error(String(error));}};
    const badge=document.createElement('small');badge.textContent=model.document.defaultPageId===page.id?'기본 페이지':'';badge.style.cssText='display:block;color:#8ab7ff;font-size:9px;padding-left:4px';const title=document.createElement('div');title.style.minWidth='0';title.append(name,badge);const controls=document.createElement('div');controls.className='page-controls';controls.style.display='none';const more=iconButton('•••','페이지 더보기',()=>{controls.style.display=controls.style.display==='none'?'flex':'none';});
    controls.append(iconButton('↑','위로',()=>{try{model.movePage(page.id,-1);callbacks.changed();}catch(error){callbacks.error(String(error));}}),iconButton('↓','아래로',()=>{try{model.movePage(page.id,1);callbacks.changed();}catch(error){callbacks.error(String(error));}}),iconButton('⧉','복제',()=>{try{model.duplicatePage(page.id);callbacks.changed();}catch(error){callbacks.error(String(error));}}),iconButton('◆','기본 페이지',()=>{try{model.setDefaultPage(page.id);callbacks.changed();}catch(error){callbacks.error(String(error));}}),iconButton('×','삭제',()=>{try{const references=pageReferences(model.document,page.id);if(references.length){const locations=references.map(reference=>`${model.document.pages.find(item=>item.id===reference.pageId)?.title??reference.pageId} · ${reference.buttonId}`).join(', ');throw new Error(`이 페이지를 가리키는 버튼을 먼저 바꾸세요: ${locations}`);}const replacement=model.document.defaultPageId===page.id?model.document.pages.find(item=>item.id!==page.id)?.id:undefined;model.deletePage(page.id,replacement);callbacks.changed();}catch(error){callbacks.error(error instanceof Error?error.message:String(error));}}));
    if(index===0)(controls.children[0] as HTMLButtonElement).disabled=true;if(index===model.document.pages.length-1)(controls.children[1] as HTMLButtonElement).disabled=true;if(model.document.pages.length===1)(controls.children[4] as HTMLButtonElement).disabled=true;
    row.append(grip,title,more,controls);container.append(row);
  });
  const standby=document.createElement('button');standby.className='standby-row'+(callbacks.standby?' selected':'');standby.innerHTML='<span>☾</span><b>대기 화면</b><small>잠금 상태</small>';standby.onclick=callbacks.selectStandby;container.append(standby);
}
