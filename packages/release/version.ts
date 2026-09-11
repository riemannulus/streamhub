import metadata from '../../package.json';

export const releaseTarget='macos-arm64' as const;
export const packageVersion=metadata.version;

if(!/^\d+\.\d+\.\d+-preview\.\d+$/.test(packageVersion))throw new Error('Invalid Streamhub package version');
