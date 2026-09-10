export type StudioButton = {
  cell: number;
  kind: 'firefox';
  label: string;
  opacity: number;
};

export type StudioConfig = {
  version: 1;
  buttons: StudioButton[];
  claude: {
    enabled: boolean;
    maxButtons: number;
    removeAfterMinutes: number;
  };
};

export type CellAction = {type: 'launch-app'; bundleId: string};

export function applicationCommand(action: CellAction): {executable: string; arguments: string[]} {
  return {executable: '/usr/bin/open', arguments: ['-b', action.bundleId]};
}

export function defaultStudioConfig(): StudioConfig {
  return {
    version: 1,
    buttons: [{cell: 5, kind: 'firefox', label: 'Firefox', opacity: 0.68}],
    claude: {enabled: true, maxButtons: 5, removeAfterMinutes: 10},
  };
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('configuration must be an object');
  return value as Record<string, unknown>;
};

const exact = (value: Record<string, unknown>, fields: string[]): void => {
  if (Object.keys(value).some(field => !fields.includes(field))) throw new Error('unknown configuration field');
};

const integer = (value: unknown, field: string, minimum: number, maximum: number): number => {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`invalid ${field}`);
  return value as number;
};

export function validateStudioConfig(input: unknown): StudioConfig {
  const raw = object(input);
  exact(raw, ['version', 'buttons', 'claude']);
  if (raw.version !== 1) throw new Error('invalid version');
  if (!Array.isArray(raw.buttons) || raw.buttons.length > 15) throw new Error('invalid buttons');
  const cells = new Set<number>();
  const buttons = raw.buttons.map(value => {
    const button = object(value);
    exact(button, ['cell', 'kind', 'label', 'opacity']);
    const cell = integer(button.cell, 'cell', 0, 14);
    if (cells.has(cell)) throw new Error('duplicate button cell');
    cells.add(cell);
    if (button.kind !== 'firefox') throw new Error('invalid button kind');
    if (typeof button.label !== 'string' || !button.label.length || button.label.length > 32) throw new Error('invalid button label');
    if (typeof button.opacity !== 'number' || !Number.isFinite(button.opacity) || button.opacity < 0.1 || button.opacity > 1) throw new Error('invalid button opacity');
    return {cell, kind: 'firefox' as const, label: button.label, opacity: button.opacity};
  });
  const claude = object(raw.claude);
  exact(claude, ['enabled', 'maxButtons', 'removeAfterMinutes']);
  if (typeof claude.enabled !== 'boolean') throw new Error('invalid enabled');
  return {
    version: 1,
    buttons,
    claude: {
      enabled: claude.enabled,
      maxButtons: integer(claude.maxButtons, 'maxButtons', 1, 15),
      removeAfterMinutes: integer(claude.removeAfterMinutes, 'removeAfterMinutes', 1, 1440),
    },
  };
}

export function updateFirefoxButton(config: StudioConfig, button: Pick<StudioButton, 'cell' | 'label' | 'opacity'>): StudioConfig {
  return validateStudioConfig({...structuredClone(config), buttons: [{...button, kind: 'firefox'}]});
}

export function actionForCell(config: StudioConfig, cell: number): CellAction | undefined {
  return config.buttons.some(button => button.cell === cell && button.kind === 'firefox')
    ? {type: 'launch-app', bundleId: 'org.mozilla.firefox'}
    : undefined;
}
