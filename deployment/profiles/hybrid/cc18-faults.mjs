import { basename, dirname } from 'node:path';

const artifactVolumeKey = 'cc18-bounded-artifacts';
const capacityBytes = 16 * 1024 * 1024;

function artifactMount(volume, artifactRoot) {
  if (basename(artifactRoot) !== 'artifacts') {
    throw new Error('Hybrid capacity requires an artifacts child directory.');
  }
  if (typeof volume === 'string') {
    const [source, target, mode] = volume.split(':');
    if (source !== artifactRoot) return volume;
    return {
      type: 'volume',
      source: artifactVolumeKey,
      target: dirname(target),
      ...(mode === 'ro' ? { read_only: true } : {}),
    };
  }
  if (volume.type !== 'bind' || volume.source !== artifactRoot) return volume;
  if (basename(volume.target) !== 'artifacts') {
    throw new Error('Hybrid capacity requires an artifacts mount target.');
  }
  return {
    ...volume,
    type: 'volume',
    source: artifactVolumeKey,
    target: dirname(volume.target),
  };
}

export function useBoundedArtifactVolume(input, { artifactRoot, volumeName }) {
  if (
    !artifactRoot.startsWith('/') ||
    !/^cc-hybrid-full-[0-9]+-[a-f0-9]{8}-artifacts$/.test(volumeName)
  ) {
    throw new Error('Hybrid capacity requires a unique bounded volume.');
  }
  const document = structuredClone(input);
  const consumers = [];
  for (const [name, service] of Object.entries(document.services ?? {})) {
    let changed = false;
    service.volumes = service.volumes?.map((volume) => {
      const replacement = artifactMount(volume, artifactRoot);
      if (replacement !== volume) changed = true;
      return replacement;
    });
    if (changed && name === 'storage-preflight') {
      const script = service.command?.at(-1);
      if (typeof script !== 'string') {
        throw new Error('Hybrid storage preflight lacks its shell command.');
      }
      service.command[service.command.length - 1] =
        `mkdir -p /check/artifacts\nchmod 700 /check/artifacts\n${script}`;
    }
    if (changed) consumers.push(name);
  }
  if (!consumers.length) {
    throw new Error('Rendered hybrid services lack the shared artifact mount.');
  }
  document.volumes ??= {};
  document.volumes[artifactVolumeKey] = {
    external: true,
    name: volumeName,
  };
  return { document, consumers };
}

export function boundedArtifactVolumeArguments(volumeName, owner) {
  if (
    !/^cc-hybrid-full-[0-9]+-[a-f0-9]{8}-artifacts$/.test(volumeName) ||
    !owner ||
    volumeName !== `${owner}-artifacts`
  ) {
    throw new Error('Hybrid capacity requires its owned volume name.');
  }
  return [
    'volume',
    'create',
    '--driver',
    'local',
    '--opt',
    'type=tmpfs',
    '--opt',
    'device=tmpfs',
    '--opt',
    `o=size=${capacityBytes},uid=1000,gid=1000,mode=0700`,
    '--label',
    'campus-commander.test=cc18-hybrid-capacity',
    '--label',
    `campus-commander.owner=${owner}`,
    volumeName,
  ];
}

export function verifyBoundedArtifactVolume(volume, volumeName, owner) {
  if (
    volume.Name !== volumeName ||
    volume.Driver !== 'local' ||
    volume.Options?.type !== 'tmpfs' ||
    volume.Options?.device !== 'tmpfs' ||
    volume.Options?.o !== `size=${capacityBytes},uid=1000,gid=1000,mode=0700` ||
    volume.Labels?.['campus-commander.test'] !== 'cc18-hybrid-capacity' ||
    volume.Labels?.['campus-commander.owner'] !== owner
  ) {
    throw new Error(
      'Docker did not preserve the owned bounded artifact volume.',
    );
  }
  return { capacityBytes, filesystemType: 0x01021994 };
}
