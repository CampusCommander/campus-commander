import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Capture actual Orca output in a private desktop and speech session. */
export async function startScreenReader() {
  assert.ok(
    process.env.DISPLAY && process.env.DBUS_SESSION_BUS_ADDRESS,
    'Run screen-reader qualification through dbus-run-session and xvfb-run.',
  );
  const root = await mkdtemp(join(tmpdir(), 'cc-phase2-orca-'));
  const packages = process.env.CC_ORCA_ROOT ?? '';
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    GSETTINGS_BACKEND: 'memory',
    ACCESSIBILITY_ENABLED: '1',
    SPEECHD_ADDRESS: `unix_socket:${root}/speech.sock`,
    SPEECHD_PLUGIN_DIR: `${packages}/usr/lib/x86_64-linux-gnu/speech-dispatcher`,
    ...(packages
      ? {
          PYTHONPATH: `${packages}/usr/lib/python3/dist-packages`,
          LD_LIBRARY_PATH: `${packages}/usr/lib/x86_64-linux-gnu`,
          GI_TYPELIB_PATH: `${packages}/usr/lib/x86_64-linux-gnu/girepository-1.0`,
          XDG_DATA_DIRS: `${packages}/usr/share:/usr/local/share:/usr/share`,
          GSETTINGS_SCHEMA_DIR: `${packages}/usr/share/glib-2.0/schemas`,
          ESPEAK_DATA_PATH: `${packages}/usr/lib/x86_64-linux-gnu`,
        }
      : {}),
  };
  for (const name of [
    'config/speech-dispatcher/modules',
    'runtime',
    'logs',
    'data',
    'cache',
  ])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, 'config/speech-dispatcher/speechd.conf'),
    'AddModule "espeak-ng" "sd_espeak-ng" "espeak-ng.conf"\nDefaultModule espeak-ng\nAudioOutputMethod "alsa"\nAudioALSADevice "null"\nLogLevel 4\n',
  );
  await writeFile(
    join(root, 'config/speech-dispatcher/modules/espeak-ng.conf'),
    'Debug 0\n',
  );
  const children = [];
  const connectionSnapshot = async () => {
    try {
      const result = await execute(
        '/usr/bin/python3',
        [
          '-c',
          `
import json
import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
desktop = Atspi.get_desktop(0)
names = [desktop.get_child_at_index(i).get_name() for i in range(desktop.get_child_count())]
print(json.dumps({'status': 'observed', 'applicationCount': len(names), 'chromiumRegistered': any('Chrome' in name or 'Chromium' in name for name in names), 'readerRegistered': any('orca' in name.lower() for name in names)}))
`,
        ],
        { env, timeout: 5000 },
      );
      return JSON.parse(result.stdout);
    } catch {
      return { status: 'unavailable' };
    }
  };
  const start = async (file, args, label) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = createWriteStream(join(root, `${label}.log`), { mode: 0o600 });
    child.stdout.on('data', (bytes) => log.write(bytes));
    child.stderr.on('data', (bytes) => log.write(bytes));
    child.once('close', () => log.end());
    children.push(child);
    await once(child, 'spawn');
    return child;
  };
  const stop = async () => {
    for (const child of [...children].reverse()) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        continue;
      const ended = once(child, 'close');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await ended;
      clearTimeout(timer);
    }
  };
  try {
    await start(
      `${packages}/usr/bin/speech-dispatcher`,
      [
        '-s',
        '-C',
        join(root, 'config/speech-dispatcher'),
        '-m',
        `${packages}/usr/lib/speech-dispatcher-modules`,
        '-L',
        join(root, 'logs'),
        '-S',
        join(root, 'speech.sock'),
        '-P',
        join(root, 'speech.pid'),
        '-t',
        '0',
      ],
      'speech',
    );
    await delay(1000);
    const version = (
      await execute(
        '/usr/bin/python3',
        [`${packages}/usr/bin/orca`, '--version'],
        { env },
      )
    ).stdout.trim();
    await start(
      '/usr/bin/python3',
      [`${packages}/usr/bin/orca`, '--debug-file', join(root, 'orca.debug')],
      'orca',
    );
    const startupDeadline = Date.now() + 30000;
    let initialConnection;
    do {
      initialConnection = await connectionSnapshot();
      if (initialConnection.readerRegistered) break;
      await delay(100);
    } while (Date.now() < startupDeadline);
    assert.equal(
      initialConnection.readerRegistered,
      true,
      'Orca must register with the accessibility desktop before the browser starts.',
    );
    const initialDebug = await readFile(join(root, 'orca.debug'), 'utf8').catch(
      () => '',
    );
    return {
      env,
      stop,
      async verify() {
        await delay(1500);
        const finalConnection = await connectionSnapshot();
        await stop();
        const debug = await readFile(join(root, 'orca.debug'), 'utf8');
        const utterances = debug.split('\n').flatMap((line) => {
          const match = line.match(/SPEECH OUTPUT: '(.*)' \{/);
          return match ? [match[1]] : [];
        });
        const checks = {
          speechConnection: !debug.includes(
            'Failed to connect to Speech Dispatcher',
          ),
          login: utterances.some((text) =>
            text.includes('Sign in to Campus Commander'),
          ),
          controls: utterances.some((text) =>
            text.includes('Check PostgreSQL'),
          ),
          completion: [
            'PostgreSQL',
            'Redis',
            'Kestra',
            'Artifact storage',
          ].every((name) =>
            utterances.some((text) =>
              text.includes(
                `${name}: The check passed. The service returned the expected result.`,
              ),
            ),
          ),
          boundedAnnouncements: !utterances.some((text) =>
            /^\w{3} \d+, \d{4},/.test(text),
          ),
          signOut: utterances.some((text) => text.includes('Sign out')),
        };
        const report = {
          status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
          recordedAt: new Date().toISOString(),
          reader: version,
          checks,
          connection: {
            beforeBrowser: initialConnection,
            afterBrowser: finalConnection,
            startupAnnouncementVisibleBeforeBrowser: initialDebug.includes(
              "SPEECH OUTPUT: 'Screen reader on.",
            ),
            explicitAccessibilityBus: Boolean(env.AT_SPI_BUS_ADDRESS),
            nativeAccessibilityEnabled: env.ACCESSIBILITY_ENABLED === '1',
            browserMentionedInDebug: /Chrome|Chromium/.test(debug),
            debugLineCount: debug.split('\n').length,
            eventLineCount: debug
              .split('\n')
              .filter((line) => /object:|window:/.test(line)).length,
          },
          utterances,
          rawEvidenceDirectory: root,
          rules: ['UI-09', 'UI-10'],
          limits: [
            'Orca and eSpeak process the real Chromium accessibility tree and speech output.',
            'The isolated ALSA null device discards audio. Human listening and usability remain separate.',
            'This fixture covers representative Phase 2 controls and diagnostic completion announcements.',
          ],
        };
        await mkdir('dist/phase-2-evidence', { recursive: true });
        await writeFile(
          'dist/phase-2-evidence/screen-reader.json',
          JSON.stringify(report, null, 2),
        );
        assert.equal(
          report.status,
          'passed',
          `Screen-reader checks failed: ${JSON.stringify(checks)}. Evidence: ${root}`,
        );
        return report;
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
