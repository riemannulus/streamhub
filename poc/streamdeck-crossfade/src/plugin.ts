import {watch} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import streamDeck, {action, type KeyDownEvent, SingletonAction, type WillAppearEvent} from '@elgato/streamdeck';
import {actionForCell, applicationCommand, validateStudioConfig, type StudioConfig} from './studio-config';

const columns = 5;
const rows = 3;
const frameIntervalMs = 38;
const studioDirectory = join(process.cwd(), 'studio');
const livePath = join(studioDirectory, 'live.json');

type LiveState = {generation: string; lastFrameIndex: number; config: StudioConfig};
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const imagePath = (state: LiveState, frameIndex: number, keyIndex: number) =>
  `studio/frames/${state.generation}/${frameIndex}/${keyIndex}.png`;

function cellIndex(event: KeyDownEvent | WillAppearEvent): number | undefined {
  if (!event.action.isKey() || !event.action.coordinates) return;
  const {column, row} = event.action.coordinates;
  if (column >= columns || row >= rows) return;
  return row * columns + column;
}

async function readLiveState(): Promise<LiveState> {
  const raw = JSON.parse(await readFile(livePath, 'utf8')) as Record<string, unknown>;
  if (typeof raw.generation !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.generation)) throw new Error('Invalid Studio generation');
  if (!Number.isInteger(raw.lastFrameIndex) || (raw.lastFrameIndex as number) < 0 || (raw.lastFrameIndex as number) > 30) throw new Error('Invalid Studio frame count');
  return {generation: raw.generation, lastFrameIndex: raw.lastFrameIndex as number, config: validateStudioConfig(raw.config)};
}

@action({UUID: 'com.streamhub.crossfade-poc.canvas-cell'})
class CanvasCell extends SingletonAction {
  private live: LiveState | undefined;
  private transitioning = false;
  private reloadQueued = false;

  async initialize(): Promise<void> {
    this.live = await readLiveState();
  }

  override async onWillAppear(event: WillAppearEvent): Promise<void> {
    const index = cellIndex(event);
    if (index === undefined || !this.live) return;
    await event.action.setImage(imagePath(this.live, this.live.lastFrameIndex, index));
  }

  override async onKeyDown(event: KeyDownEvent): Promise<void> {
    const index = cellIndex(event);
    if (index === undefined || !this.live) return;
    const effect = actionForCell(this.live.config, index);
    if (!effect) return;
    const command = applicationCommand(effect);
    const child = spawn(command.executable, command.arguments, {detached: true, stdio: 'ignore'});
    child.once('error', error => streamDeck.logger.error(`launch failed: ${String(error)}`));
    child.unref();
    streamDeck.logger.info(`launched ${effect.bundleId} from cell ${index + 1}`);
  }

  async reload(): Promise<void> {
    if (this.transitioning) {
      this.reloadQueued = true;
      return;
    }
    const next = await readLiveState();
    if (next.generation === this.live?.generation) return;
    this.transitioning = true;
    const startedAt = performance.now();
    try {
      for (let frameIndex = 0; frameIndex <= next.lastFrameIndex; frameIndex += 1) {
        const frameStartedAt = performance.now();
        const updates = this.actions
          .filter(item => item.isKey() && item.coordinates !== undefined)
          .map(item => {
            if (!item.isKey() || !item.coordinates) return Promise.resolve();
            const {column, row} = item.coordinates;
            if (column >= columns || row >= rows) return Promise.resolve();
            return item.setImage(imagePath(next, frameIndex, row * columns + column));
          })
          .toArray();
        await Promise.all(updates);
        const dispatchMs = performance.now() - frameStartedAt;
        await sleep(Math.max(0, frameIntervalMs - dispatchMs));
      }
      this.live = next;
      streamDeck.logger.info(`Studio generation ${next.generation} applied to ${this.actions.length} cells in ${Math.round(performance.now() - startedAt)}ms`);
    } finally {
      this.transitioning = false;
      if (this.reloadQueued) {
        this.reloadQueued = false;
        void this.reload().catch(error => streamDeck.logger.error(`Studio queued reload failed: ${String(error)}`));
      }
    }
  }
}

streamDeck.logger.setLevel('trace');
const canvas = new CanvasCell();
await canvas.initialize();
streamDeck.actions.registerAction(canvas);
streamDeck.connect();

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
watch(studioDirectory, {persistent: false}, (_event, filename) => {
  if (filename !== 'live.json') return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void canvas.reload().catch(error => streamDeck.logger.error(`Studio reload failed: ${String(error)}`)), 60);
});
