import {updateFirefoxButton, type StudioConfig} from '../src/studio-config';
import {studioConnectionMessage} from '../src/studio-connection';
import {streamDeckClassicGeometry, streamDeckClassicKeyViewport} from '../src/streamdeck-classic-geometry';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
let token = '';
let config: StudioConfig;
let saved = '';
let generation = '';
let online = false;
let initialized = false;
const keys: HTMLButtonElement[] = [];

function message(text = '', kind: 'ok' | 'error' = 'ok') {
  const element = $('message');
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('error', kind === 'error');
}

function dirty() {
  return JSON.stringify(config) !== saved;
}

function status() {
  const changed = dirty();
  $('save-state').textContent = changed ? '적용하지 않은 변경' : '장치와 동기화됨';
  $('save-state').classList.toggle('dirty', changed);
  $<HTMLButtonElement>('apply').disabled = !changed || !online;
}

function connection(connected: boolean) {
  online = connected;
  $('connection').classList.toggle('offline', !connected);
  $('connection').querySelector('span')!.textContent = connected ? 'Studio 연결됨' : 'Studio 연결 끊김';
  if (initialized) status();
}

function currentButton() {
  return config.buttons[0]!;
}

function renderDeck() {
  const button = currentButton();
  for (const [index, key] of keys.entries()) {
    const viewport = streamDeckClassicKeyViewport(index);
    key.style.backgroundImage = `url('/api/background?v=${encodeURIComponent(generation)}')`;
    key.style.backgroundSize = `${streamDeckClassicGeometry.width / viewport.width * 100}% ${streamDeckClassicGeometry.height / viewport.height * 100}%`;
    key.style.backgroundPosition = `${viewport.left / (streamDeckClassicGeometry.width - viewport.width) * 100}% ${viewport.top / (streamDeckClassicGeometry.height - viewport.height) * 100}%`;
    key.classList.toggle('selected', index === button.cell);
    key.replaceChildren();
    if (index === button.cell) {
      const overlay = document.createElement('span');
      overlay.className = 'key-button';
      overlay.style.setProperty('--button-opacity', String(button.opacity));
      overlay.innerHTML = `<span class="firefox-mark" aria-hidden="true">◉</span><strong></strong>`;
      overlay.querySelector('strong')!.textContent = button.label;
      key.append(overlay);
    }
    const number = document.createElement('small');
    number.textContent = String(index + 1).padStart(2, '0');
    key.append(number);
    key.setAttribute('aria-label', `키 ${index + 1}${index === button.cell ? `: ${button.label}` : ''}`);
  }
}

function update(mutator: () => void) {
  mutator();
  renderDeck();
  status();
  message();
}

for (let index = 0; index < 15; index += 1) {
  const key = document.createElement('button');
  key.type = 'button';
  key.className = 'key';
  key.onclick = () => update(() => {
    config = updateFirefoxButton(config, {...currentButton(), cell: index});
    select('cell').value = String(index);
  });
  $('deck').append(key);
  keys.push(key);
  const option = document.createElement('option');
  option.value = String(index);
  option.textContent = `${Math.floor(index / 5) + 1}행 ${index % 5 + 1}열 · 키 ${index + 1}`;
  select('cell').append(option);
}

async function load() {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw new Error('Studio를 불러오지 못했습니다.');
  const payload = await response.json();
  token = payload.token;
  if (!initialized) config = payload.config;
  generation = payload.generation;
  if (!initialized) saved = JSON.stringify(config);
  connection(true);
  initialized = true;
  input('label').value = currentButton().label;
  select('cell').value = String(currentButton().cell);
  input('opacity').value = String(Math.round(currentButton().opacity * 100));
  $('opacity-value').textContent = `${input('opacity').value}%`;
  input('claude-enabled').checked = config.claude.enabled;
  input('max-buttons').value = String(config.claude.maxButtons);
  input('remove-after').value = String(config.claude.removeAfterMinutes);
  renderDeck();
  status();
}

async function reconnect() {
  if (online) return;
  try {
    await load();
    message('Studio 서버에 다시 연결했습니다. 편집 중인 변경은 그대로 유지됩니다.');
  } catch {
    connection(false);
  }
}

input('label').oninput = () => update(() => {
  const label = input('label').value.trim() || 'Firefox';
  config = updateFirefoxButton(config, {...currentButton(), label});
});
select('cell').onchange = () => update(() => {
  config = updateFirefoxButton(config, {...currentButton(), cell: Number(select('cell').value)});
});
input('opacity').oninput = () => update(() => {
  $('opacity-value').textContent = `${input('opacity').value}%`;
  config = updateFirefoxButton(config, {...currentButton(), opacity: Number(input('opacity').value) / 100});
});
for (const id of ['claude-enabled', 'max-buttons', 'remove-after']) input(id).onchange = () => update(() => {
  config = {
    ...config,
    claude: {
      enabled: input('claude-enabled').checked,
      maxButtons: Number(input('max-buttons').value),
      removeAfterMinutes: Number(input('remove-after').value),
    },
  };
});

$<HTMLButtonElement>('apply').onclick = async () => {
  const button = $<HTMLButtonElement>('apply');
  button.disabled = true;
  button.textContent = '적용 중…';
  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Streamhub-Studio': token},
      body: JSON.stringify(config),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    config = payload.config;
    generation = payload.generation;
    saved = JSON.stringify(config);
    renderDeck();
    message('새 화면을 장치에 적용했습니다.');
  } catch (error) {
    connection(!(error instanceof TypeError));
    message(studioConnectionMessage(error), 'error');
  } finally {
    button.textContent = '장치에 적용';
    status();
  }
};

input('background').onchange = async () => {
  const file = input('background').files?.[0];
  if (!file) return;
  try {
    message('배경을 처리하고 있습니다…');
    const response = await fetch('/api/background', {
      method: 'POST',
      headers: {'Content-Type': file.type || 'application/octet-stream', 'X-Streamhub-Studio': token},
      body: file,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    config = payload.config;
    generation = payload.generation;
    saved = JSON.stringify(config);
    renderDeck();
    status();
    message('새 배경을 장치에 적용했습니다.');
  } catch (error) {
    connection(!(error instanceof TypeError));
    message(studioConnectionMessage(error), 'error');
  } finally {
    input('background').value = '';
  }
};

void load().catch(error => {
  connection(false);
  message(studioConnectionMessage(error), 'error');
});
setInterval(() => void reconnect(), 2000);
