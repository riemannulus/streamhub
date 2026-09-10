import {expect, test} from 'bun:test';
import {studioConnectionMessage} from './studio-connection';

test('turns a network failure into an actionable Studio message', () => {
  expect(studioConnectionMessage(new TypeError('Failed to fetch')))
    .toBe('Studio 서버와 연결이 끊겼습니다. 터미널에서 bun run studio를 실행하면 자동으로 다시 연결합니다.');
  expect(studioConnectionMessage(new Error('설정이 잘못되었습니다.'))).toBe('설정이 잘못되었습니다.');
});
