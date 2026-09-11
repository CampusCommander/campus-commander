import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const source = await readFile(resolve('install.sh'), 'utf8');
const helpers = source.slice(
  source.indexOf('  # Host preparation helpers'),
  source.indexOf('  # End host preparation helpers.'),
);

// Execute the shipped shell functions with isolated commands and simulated hosts.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cc-prerequisites-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  // Exclude real package managers, Docker, and sudo from the harness PATH.
  for (const name of ['node', 'chmod', 'grep']) {
    const path = spawnSync('/bin/sh', ['-c', `command -v ${name}`], {
      encoding: 'utf8',
    }).stdout.trim();
    await symlink(path, join(bin, name));
  }
  const stage = join(root, 'stage');
  await mkdir(join(stage, 'tools'), { recursive: true });
  await mkdir(join(stage, 'bundle/deployment/installer'), { recursive: true });
  await writeFile(
    join(stage, 'bundle/deployment/installer/platforms.mjs'),
    await readFile('deployment/installer/platforms.mjs'),
  );
  const run = (body, extra = {}) =>
    spawnSync(
      '/bin/sh',
      [
        '-c',
        `
set -eu
cc_color= cc_reset= cc_answers= cc_dependencies=yes cc_sudo=no
cc_profile=all-docker cc_distribution=ubuntu cc_codename=noble
cc_stage="$CC_TEST_STAGE"
cc_say() { printf '%s\\n' "$*" >&2; }
cc_fail() { cc_say "Installation stopped: $*"; exit 1; }
cc_prompt() { cc_fail 'Unexpected interactive prompt'; }
id() { printf '0\\n'; }
${helpers}
${body}
`,
      ],
      {
        env: { PATH: bin, CC_TEST_STAGE: stage, ...extra },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
  return { root, stage, bin, run };
}

const dockerReady = `
docker() {
  case "$1 $2" in
    'version --format') printf '29.8.0\\n' ;;
    'compose version') printf '5.5.1\\n' ;;
    'context show') printf 'default\\n' ;;
    'context inspect') printf 'unix:///var/run/docker.sock\\n' ;;
    *) return 1 ;;
  esac
}
`;

test('restricted container gets nesting instructions before any release download', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_container() { return 0; }
cc_systemd() { return 1; }
cc_container_capable() { return 1; }
cc_host_route
printf 'download-started'
`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /docker run.*--privileged.*--cgroupns=private/);
  assert.match(r.stderr, /cannot grant host permissions from inside/);
  assert.doesNotMatch(r.stderr, /VM in Hyper-V/);
  assert.doesNotMatch(r.stdout, /download-started/);
});

test('capable container can prepare its own Docker daemon without systemd', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_container() { return 0; }
cc_systemd() { return 1; }
cc_container_capable() { return 0; }
cc_host_route
`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /can prepare a private daemon inside this container/);
});

test('container with only the Docker client installs and starts its daemon', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_started=no
cc_container() { return 0; }
cc_systemd() { return 1; }
cc_container_capable() { return 0; }
docker() {
  case "$1 $2" in
    'version --format') [ "$cc_started" = yes ] || return 1; printf '29.8.0\\n' ;;
    'compose version') printf '5.5.1\\n' ;;
    'context show') printf 'default\\n' ;;
    'context inspect') printf 'unix:///var/run/docker.sock\\n' ;;
  esac
}
cc_install_docker_packages() { printf 'install-%s\\n' "$1"; dockerd() { return 0; }; }
cc_start_container_docker() { printf 'start-private-daemon\\n'; cc_started=yes; }
cc_prepare_docker
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'install-engine\nstart-private-daemon\n');
});

test('container with a working daemon continues to filesystem qualification', async (t) => {
  const f = await fixture(t);
  const r = f.run(`${dockerReady}
cc_container() { return 0; }
cc_systemd() { return 1; }
cc_host_route
`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Docker daemon\s+reachable/);
});

test('Kubernetes does not require a local Docker daemon', async (t) => {
  const f = await fixture(t);
  const r = f.run('cc_profile=kubernetes; cc_host_route');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('ready Docker and Compose require no changes or sudo', async (t) => {
  const f = await fixture(t);
  const r = f.run(`${dockerReady}
cc_as_root() { cc_fail 'Unexpected system change'; }
cc_dependencies=no
cc_prepare_docker
`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Docker Engine\s+29.8.0/);
  assert.match(r.stderr, /Docker Compose\s+5.5.1/);
});

test('fresh Linux host installs Docker then starts its daemon', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_started=no
cc_systemd() { return 0; }
systemctl() { [ "$cc_started" = yes ]; }
cc_install_docker_packages() {
  printf 'install-%s\\n' "$1"
  docker() {
    case "$1 $2" in
      'version --format') [ "$cc_started" = yes ] || return 1; printf '29.8.0\\n' ;;
      'compose version') printf '5.5.1\\n' ;;
      'context show') printf 'default\\n' ;;
      'context inspect') printf 'unix:///var/run/docker.sock\\n' ;;
    esac
  }
}
cc_as_root() { printf 'root %s\\n' "$*"; cc_started=yes; }
cc_prepare_docker
`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /install-engine\nroot systemctl start docker/);
});

test('missing Compose repairs the plugin without reinstalling Docker Engine', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_has_compose=no
docker() {
  if [ "$1" = compose ]; then [ "$cc_has_compose" = yes ] || return 1; printf '5.5.1\\n'
  else printf '29.8.0\\n'; fi
}
cc_install_docker_packages() { printf 'install-%s\\n' "$1"; cc_has_compose=yes; }
cc_prepare_docker
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'install-compose\n');
});

test('manual instructions permit repair in another terminal and recheck', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_dependencies=ask
cc_has_terminal() { return 0; }
cc_prompt() {
  case "$1" in
    'Choose '*) cc_reply=2 ;;
    'Press Enter'*) cc_reply=; keytool() { return 0; } ;;
  esac
}
cc_packages() { cc_fail 'Unexpected package installation'; }
cc_require_package_tool keytool default-jre-headless 'Java keytool is missing.'
`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stderr,
    /sudo apt-get install --no-remove default-jre-headless/,
  );
  assert.match(r.stderr, /keytool\s+ready/);
});

test('refusing changes prints concrete commands without invoking apt', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_dependencies=no
cc_packages() { printf 'unexpected-apt'; }
cc_require_package_tool keytool default-jre-headless 'Java keytool is missing.'
`);
  assert.notEqual(r.status, 0);
  assert.match(
    r.stderr,
    /sudo apt-get install --no-remove default-jre-headless/,
  );
  assert.equal(r.stdout, '');
});

test('automation without explicit dependency consent never prompts or installs', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_dependencies=ask cc_answers=/private/answers.json
cc_choose_repair 'Missing package' 'Install package' 'Manual package instructions'
printf 'unexpected-install'
`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--install-dependencies/);
  assert.doesNotMatch(r.stderr, /Unexpected interactive prompt/);
  assert.equal(r.stdout, '');
});

test('automatic base-tool installation rechecks the original missing tools', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_installed=no
cc_base_missing() { cc_missing=; [ "$cc_installed" = yes ] || cc_missing=' curl ca-certificates'; return 0; }
cc_apt_supported() { return 0; }
cc_packages() { printf 'packages %s\\n' "$*"; cc_installed=yes; }
cc_prepare_base
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'packages curl ca-certificates\n');
  assert.match(r.stderr, /Download tools\s+ready/);
});

test('failed package installation stops before any success claim', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_stage=
cc_apt_supported() { return 0; }
cc_as_root() { printf 'command %s\\n' "$*"; return 1; }
cc_packages curl
printf 'unexpected-success'
`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Update package indexes failed/);
  assert.equal(r.stdout, 'command apt-get update\n');
});

test('system package install cannot consume the piped installer input', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
package_manager() { if read -r input; then printf 'consumed:%s' "$input"; return 1; fi; }
printf 'installer-script-input' | cc_as_root package_manager
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('unattended sudo fails without reading a password or running a command', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
id() { printf '1000\\n'; }
sudo() { printf 'sudo %s\\n' "$*"; return 1; }
cc_answers=/private/answers.json
cc_as_root apt-get update
`);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, 'sudo -n -v\n');
  assert.match(r.stderr, /Sudo authorization is unavailable/);
});

test('remote Docker failures never start a different local daemon', async (t) => {
  const f = await fixture(t);
  const r = f.run(
    `
docker() { return 1; }
cc_systemd() { printf 'unexpected-service-check'; return 0; }
cc_prepare_docker
`,
    { DOCKER_HOST: 'tcp://district-docker:2376' },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /selected Docker endpoint is unavailable/);
  assert.equal(r.stdout, '');
});

test('Docker versions come from the verified release contract', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_platform_passes dockerEngine 29.8.0
if cc_platform_passes dockerEngine 30.0.0; then exit 1; fi
if cc_platform_passes dockerCompose 2.30.0; then exit 1; fi
cc_platform_passes dockerCompose 5.5.1
`);
  assert.equal(r.status, 0, r.stderr);
});

test('apt version selection excludes unsupported majors and sorts compatible versions', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.bin, 'apt-cache'),
    `#!/bin/sh
  printf '%s\\n' 'docker-ce | 5:30.0.0-1~ubuntu.24.04~noble | repo' \
    'docker-ce | 5:29.8.0-1~ubuntu.24.04~noble | repo' \
    'docker-ce | 5:29.10.0-1~ubuntu.24.04~noble | repo' \
    'docker-ce | 5:29.7.1-1~ubuntu.24.04~noble | repo'
`,
    { mode: 0o700 },
  );
  const r = f.run('cc_docker_package_version docker-ce dockerEngine');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '5:29.10.0-1~ubuntu.24.04~noble');
});

test('package selection stops if no version satisfies the release', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.bin, 'apt-cache'),
    `#!/bin/sh
printf '%s\\n' 'docker-ce | 5:30.0.0-1~ubuntu.24.04~noble | repo'
`,
    { mode: 0o700 },
  );
  const r = f.run('cc_docker_package_version docker-ce dockerEngine');
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});

test('daemon restart resumes an existing installation through its verified stop command', async (t) => {
  const f = await fixture(t);
  const r = f.run(`
cc_container_daemon_started=yes cc_existing=yes cc_command=resume cc_existing_root=/private/installation
node() {
  if [ "$1" = -p ]; then printf 'yes'; else printf '%s\\n' "$@"; fi
}
cc_recover_container_installation
`);
  assert.equal(r.status, 0, r.stderr);
  const command = await readFile(
    join(f.stage, 'container-recovery.json'),
    'utf8',
  );
  assert.equal(
    command,
    `${f.stage}/bundle/deployment/installer/cli.mjs\nstop\n/private/installation/operator.json\n--qualification\n`,
  );
});

for (const command of ['status', '']) {
  test(`unattended ${command || 'unspecified operation'} does not stop services after daemon recovery`, async (t) => {
    const f = await fixture(t);
    const r = f.run(`
cc_container_daemon_started=yes cc_existing=yes cc_command='${command}' cc_answers=/private/answers.json
node() { cc_fail 'Unexpected service change'; }
cc_recover_container_installation
`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Use --command resume/);
  });
}
