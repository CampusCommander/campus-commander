const contracts = {
  dockerEngine: {
    label: 'Docker Engine',
    minimumVersion: '29.7.2',
    supportedMajor: 29,
    evidenceVersions: ['29.7.2', '29.8.0'],
  },
  dockerCompose: {
    label: 'Docker Compose',
    minimumVersion: '5.5.0',
    supportedMajor: 5,
    evidenceVersions: ['5.5.0', '5.5.1'],
  },
  kubernetes: {
    label: 'Kubernetes',
    minimumVersion: '1.35.8',
    supportedMajor: 1,
    evidenceVersions: ['1.35.8', '1.37.0'],
  },
};

export const qualifiedPlatformVersions = Object.freeze(
  Object.fromEntries(
    Object.entries(contracts).map(([name, value]) => [
      name,
      Object.freeze({
        ...value,
        evidenceVersions: Object.freeze([...value.evidenceVersions]),
      }),
    ]),
  ),
);

function parseVersion(value) {
  if (typeof value !== 'string') return undefined;
  const number = '(0|[1-9][0-9]*)';
  const build = '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
  const match = new RegExp(
    `^v?${number}\\.${number}\\.${number}${build}$`,
  ).exec(value.trim());
  if (!match) return undefined;
  const parsed = match.slice(1, 4).map(Number);
  return parsed.every(Number.isSafeInteger) ? parsed : undefined;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function evaluatePlatformVersion(platformName, value) {
  const contract = qualifiedPlatformVersions[platformName];
  if (!contract) throw new Error('Unknown installation platform.');
  const parsed = parseVersion(value);
  return {
    passed:
      parsed !== undefined &&
      parsed[0] === contract.supportedMajor &&
      compareVersions(parsed, parseVersion(contract.minimumVersion)) >= 0,
    observedVersion: typeof value === 'string' ? value.trim() : '',
    minimumVersion: contract.minimumVersion,
    supportedMajor: contract.supportedMajor,
    evidenceVersions: contract.evidenceVersions,
  };
}
