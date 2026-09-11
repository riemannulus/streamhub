import {expect,test} from 'bun:test';
import {parseDisplayModeArgs,publicStatus,recoveryBound} from './display-mode-check';

test('display check accepts only explicit physical modes with fixed bounds',()=>{expect(parseDisplayModeArgs(['--mode','hid'])).toBe('hid');expect(parseDisplayModeArgs(['--mode','plugin'])).toBe('plugin');expect(recoveryBound('hid')).toBe(1000);expect(recoveryBound('plugin')).toBe(3000);expect(()=>parseDisplayModeArgs(['--mode','off'])).toThrow('Usage');});
test('display check accepts only sanitized runtime status',()=>{expect(publicStatus({configuredMode:'hid',activeMode:'hid',state:'ready',restartRequired:false,tokenFile:'/secret'})).toEqual({configuredMode:'hid',activeMode:'hid',state:'ready',restartRequired:false});expect(()=>publicStatus({configuredMode:'hid',activeMode:'plugin',state:'broken',restartRequired:true})).toThrow();});
