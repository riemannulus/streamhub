import {expect,test} from 'bun:test';
import {displayModeCopy,displayRestartRequired} from './display-settings';

test('display mode copy discloses ownership and transport limitations',()=>{
  expect(displayModeCopy('hid').description).toContain('완전히 종료');
  expect(displayModeCopy('plugin').description).toContain('제한');
  expect(displayModeCopy('off').title).toBe('사용 안 함');
});

test('restart warning compares configured and active modes only',()=>{
  expect(displayRestartRequired({configuredMode:'hid',activeMode:'plugin'})).toBe(true);
  expect(displayRestartRequired({configuredMode:'hid',activeMode:'hid'})).toBe(false);
});
