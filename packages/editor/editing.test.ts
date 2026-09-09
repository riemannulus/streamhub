import {expect,test} from 'bun:test';
import {BoardHistory,createTemplate,duplicatePage,movePage} from './editing';
import {validatePageConfig,type PageConfig} from '../streamdeck/pages';
const initial=():PageConfig=>({defaultPage:'home',pages:[{id:'home',title:'Home',buttons:[{index:0,type:'page',pageId:'home'}]},{id:'work',title:'Work',signals:{}}]});

test('history clones drafts, supports invalid intermediate edits and branches undo/redo',()=>{
  const board=initial(),history=new BoardHistory(board);
  board.pages[0].title='';history.push(board);
  board.pages[0].title='Later';
  expect(history.undo()?.pages[0].title).toBe('Home');
  const invalid=history.redo()!;expect(invalid.pages[0].title).toBe('');
  invalid.pages[0].title='Outside';
  expect(history.undo()?.pages[0].title).toBe('Home');
  expect(history.redo()?.pages[0].title).toBe('');
  history.undo();history.push({...initial(),transition:'none'});
  expect(history.canRedo).toBe(false);expect(history.canUndo).toBe(true);
  expect(history.redo()).toBeUndefined();
  const undone=history.undo()!;undone.pages[0].title='Mutated';
  expect(history.undo()).toBeUndefined();
  expect(history.redo()?.pages[0].title).toBe('Home');
});
test('history deduplicates unchanged edits, resets and caps retained states at 100',()=>{
  const history=new BoardHistory(initial());history.push(initial());expect(history.canUndo).toBe(false);
  for(let index=0;index<120;index++){const board=initial();board.pages[0].title=String(index);history.push(board);}
  let count=0;while(history.undo())count++;
  expect(count).toBe(99);
  const board=initial();history.reset(board);board.pages[0].title='Outside';
  expect(history.canUndo).toBe(false);expect(history.canRedo).toBe(false);
  const modified=initial();modified.pages[0].title='New';history.push(modified);
  expect(history.undo()?.pages[0].title).toBe('Home');
});
test('duplicate remaps self references while preserving default and unrelated references',()=>{
  const board=initial();board.pages[0].buttons!.push({index:1,type:'page',pageId:'work'});
  const first=duplicatePage(board,'home');const copy=first.board.pages.at(-1)!;
  expect(first.selected).toBe('home-copy');expect(copy.title).toBe('Home (복사)');
  expect(copy.buttons).toEqual([{index:0,type:'page',pageId:'home-copy'},{index:1,type:'page',pageId:'work'}]);
  expect(first.board.defaultPage).toBe('home');expect(board.pages).toHaveLength(2);
  const second=duplicatePage(first.board,'home');expect(second.selected).toBe('home-copy-2');
  expect(second.board.pages.at(-1)!.title).toBe('Home (복사 2)');
  copy.buttons!.length=0;expect(board.pages[0].buttons).toHaveLength(2);
  expect(()=>duplicatePage(board,'missing')).toThrow();
});
test('reordering preserves references and boundary movement is an isolated no-op',()=>{
  const board=initial(),moved=movePage(board,'work',-1);
  expect(moved.pages.map(page=>page.id)).toEqual(['work','home']);expect(moved.defaultPage).toBe('home');
  expect(board.pages[0].id).toBe('home');
  const unchanged=movePage(board,'home',-1);unchanged.pages[0].title='Changed';expect(board.pages[0].title).toBe('Home');
  expect(()=>movePage(board,'missing',1)).toThrow();
});
test('templates validate source filters and preserve pagination controls and page limits',()=>{
  for(const kind of ['all','source','tools'] as const){
    const result=createTemplate(initial(),kind,'demo');expect(validatePageConfig(result.board)).toEqual(result.board);
    const page=result.board.pages.at(-1)!;
    expect(page.buttons?.some(button=>button.index===10||button.index===14)).toBe(false);
    expect(page.signals).toEqual(kind==='tools'?undefined:kind==='source'?{source:'demo'}:{});
  }
  expect(()=>createTemplate(initial(),'source')).toThrow();
  expect(()=>createTemplate(initial(),'source','bad source')).toThrow();
  let board=initial();while(board.pages.length<32)board=createTemplate(board,'all').board;
  expect(()=>createTemplate(board,'tools')).toThrow();expect(()=>duplicatePage(board,'home')).toThrow();
});
