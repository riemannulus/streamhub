import type {TransitionSpec} from '../studio/document';

export type DeckBackendKind='hid'|'plugin';
export type PresentationReason='initial'|'page'|'refresh'|'standby'|'unlock'|'reconnect';
export type DeckSurface={identity:string;png:Buffer;keyPngs:readonly Buffer[]};
export type PresentationRequest={
  generation:string;
  reason:PresentationReason;
  from?:DeckSurface;
  to:DeckSurface;
  transition:TransitionSpec;
  inputEnabled:boolean;
};
export type PreparedPresentation=Readonly<{backend:DeckBackendKind;generation:string;token:string}>;
export type DeckBackendStatus={
  mode:DeckBackendKind;
  state:'connecting'|'ready'|'recovering'|'unavailable';
  connected:boolean;
  message?:string;
};
export type DeckBackendEvents={
  key(event:{index:number;phase:'down'|'up';generation:string}):void;
  ready():void;
};
export interface DeckBackend{
  prepare(request:PresentationRequest):Promise<PreparedPresentation>;
  present(prepared:PreparedPresentation):Promise<void>;
  status():DeckBackendStatus;
  stop():Promise<void>;
}
