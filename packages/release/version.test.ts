import {expect,test} from 'bun:test';
import {packageVersion,releaseTarget} from './version';

test('release identity is one validated macOS arm64 preview version',()=>{
  expect(packageVersion).toBe('0.1.0-preview.1');
  expect(releaseTarget).toBe('macos-arm64');
});
