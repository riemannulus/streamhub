import {describe, expect, test} from 'bun:test';
import {actionForCell, applicationCommand, defaultStudioConfig, updateFirefoxButton, validateStudioConfig} from './studio-config';

describe('Studio configuration', () => {
  test('normalizes the editable Firefox button without changing the input', () => {
    const input = defaultStudioConfig();
    const updated = updateFirefoxButton(input, {cell: 6, opacity: 0.42, label: '웹 열기'});

    expect(updated.buttons).toEqual([{cell: 6, kind: 'firefox', label: '웹 열기', opacity: 0.42}]);
    expect(input.buttons).toEqual([{cell: 5, kind: 'firefox', label: 'Firefox', opacity: 0.68}]);
  });

  test('maps only the configured cell to a Firefox launch action', () => {
    const config = defaultStudioConfig();

    expect(actionForCell(config, 5)).toEqual({type: 'launch-app', bundleId: 'org.mozilla.firefox'});
    expect(actionForCell(config, 4)).toBeUndefined();
  });

  test('builds the macOS application launch without a shell', () => {
    expect(applicationCommand({type: 'launch-app', bundleId: 'org.mozilla.firefox'}))
      .toEqual({executable: '/usr/bin/open', arguments: ['-b', 'org.mozilla.firefox']});
  });

  test('rejects duplicate, out-of-range and malformed buttons', () => {
    const base = defaultStudioConfig();
    expect(() => validateStudioConfig({...base, buttons: [{...base.buttons[0]!, cell: 15}]})).toThrow('cell');
    expect(() => validateStudioConfig({...base, buttons: [base.buttons[0]!, base.buttons[0]!]})).toThrow('duplicate');
    expect(() => validateStudioConfig({...base, buttons: [{...base.buttons[0]!, opacity: 1.1}]})).toThrow('opacity');
  });

  test('keeps the Claude automation rule bounded', () => {
    const base = defaultStudioConfig();
    expect(validateStudioConfig({...base, claude: {enabled: true, maxButtons: 5, removeAfterMinutes: 10}}).claude)
      .toEqual({enabled: true, maxButtons: 5, removeAfterMinutes: 10});
    expect(() => validateStudioConfig({...base, claude: {...base.claude, maxButtons: 16}})).toThrow('maxButtons');
  });
});
