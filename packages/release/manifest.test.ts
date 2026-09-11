import {expect,test} from 'bun:test';
import {createReleaseManifest,validateReleaseManifest} from './manifest';

const expected={formatVersion:1 as const,name:'streamhub' as const,version:'0.1.0-preview.1',target:'macos-arm64' as const,gitCommit:'a'.repeat(40),builtAt:'2026-09-11T00:00:00.000Z',bun:'1.4.0' as const,studioSchema:3 as const,pluginVersion:'0.2.0.0',displayModes:['off','hid','plugin'] as const};

test('manifest exposes bounded package and protocol compatibility',()=>{
  expect(createReleaseManifest({gitCommit:'a'.repeat(40),builtAt:'2026-09-11T00:00:00.000Z',pluginVersion:'0.2.0.0'})).toEqual(expected);
  expect(validateReleaseManifest(expected)).toEqual(expected);
});

test('manifest rejects unknown, missing, inconsistent, and unsafe values',()=>{
  for(const value of [
    {...expected,token:'secret'},
    {...expected,version:'latest'},
    {...expected,target:'macos-x64'},
    {...expected,gitCommit:'../unsafe'},
    {...expected,builtAt:'yesterday'},
    {...expected,displayModes:['hid','plugin']},
    null,
  ])expect(()=>validateReleaseManifest(value)).toThrow('manifest');
});
