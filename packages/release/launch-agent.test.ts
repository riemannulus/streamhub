import {expect,test} from 'bun:test';
import {launchAgentPaths,parseLaunchctlPrint,renderLaunchAgent,validateOwnedLaunchAgent} from './launch-agent';

const input={
  home:'/Users/example',uid:501,bunPath:'/opt/homebrew/bin/bun',
  packageRoot:'/Users/example/Library/Application Support/Streamhub/app/0.1.0-preview.1',
};

test('LaunchAgent paths remain inside the user and installed Streamhub roots',()=>{
  expect(launchAgentPaths(input)).toEqual({
    label:'com.streamhub.runtime',domain:'gui/501',service:'gui/501/com.streamhub.runtime',
    plistPath:'/Users/example/Library/LaunchAgents/com.streamhub.runtime.plist',
    configPath:'/Users/example/Library/Application Support/Streamhub/data/config.json',
    logPath:'/Users/example/Library/Application Support/Streamhub/data/logs/runtime.log',
    previousLogPath:'/Users/example/Library/Application Support/Streamhub/data/logs/runtime.log.1',
    runtimePath:'/Users/example/Library/Application Support/Streamhub/app/0.1.0-preview.1/app/runtime.ts',
  });
});

test('rendered plist is escaped, owned, absolute and round-trips validation',()=>{
  const xml=renderLaunchAgent({...input,bunPath:'/Applications/Bun & Tools/bin/bun'});
  expect(xml).toContain('<!-- Managed by Streamhub Preview -->');
  expect(xml).toContain('/Applications/Bun &amp; Tools/bin/bun');
  expect(()=>validateOwnedLaunchAgent(xml,input)).toThrow('Bun path');
  expect(()=>validateOwnedLaunchAgent(renderLaunchAgent(input),input)).not.toThrow();
});

test('launchctl output projects only bounded process state',()=>{
  expect(parseLaunchctlPrint('state = running\npid = 123\nlast exit code = 7\ntoken = secret')).toEqual({loaded:true,running:true,pid:123,lastExitStatus:7});
  expect(parseLaunchctlPrint('state = exited\nlast exit code = 0')).toEqual({loaded:true,running:false,lastExitStatus:0});
});

test('input validation rejects unsafe roots and uid values',()=>{
  expect(()=>launchAgentPaths({...input,home:'Users/example'})).toThrow('absolute');
  expect(()=>launchAgentPaths({...input,uid:0})).toThrow('uid');
  expect(()=>launchAgentPaths({...input,packageRoot:'/Users/example/app/0.1.0'})).toThrow('Streamhub');
  expect(()=>launchAgentPaths({...input,bunPath:'/bin/bun\0unsafe'})).toThrow('NUL');
});

test('ownership validation rejects arguments outside the exact expected pair',()=>{
  const xml=renderLaunchAgent(input).replace(
    '</array>',
    '<string>--inspect</string></array>',
  );
  expect(()=>validateOwnedLaunchAgent(xml,input)).toThrow('ProgramArguments');
});

test('launchctl projection ignores malformed and out-of-range values',()=>{
  expect(parseLaunchctlPrint('state = running\npid = 0\nlast exit code = 2147483648\nsecret = value')).toEqual({loaded:true,running:true});
  expect(parseLaunchctlPrint('state = sleeping\npid = 12.5\nlast exit code = -2147483648')).toEqual({loaded:true,running:false,lastExitStatus:-2147483648});
});
