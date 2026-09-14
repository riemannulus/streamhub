import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

test('user docs describe explicit Runtime-only login service commands',()=>{
  const readme=readFileSync('README.md','utf8'),development=readFileSync('DEVELOPMENT.md','utf8');
  for(const command of ['streamhub daemon enable','streamhub daemon disable','streamhub daemon restart','streamhub daemon status','streamhub daemon logs'])expect(readme).toContain(command);
  expect(readme).toContain('Studio는 로그인 시 자동 실행되지 않습니다');expect(readme).toContain('Ctrl-C');
  expect(readme).not.toContain('streamhub daemon studio');
  expect(development).toContain('com.streamhub.runtime');
});
