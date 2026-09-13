import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** Keep one owned capped volume mounted throughout the synthetic cluster lifetime. */
export async function createKubernetesCapacityVolume({
  docker,
  project,
  image,
  root,
}) {
  assert.match(project, /^cc-capacity-kube-[a-f0-9]{12}$/);
  assert.ok(root.startsWith(`/tmp/${project}-`));
  const name = `${project}-artifacts`,
    anchor = `${project}-artifact-anchor`;
  let volumeCreated = false,
    anchorCreated = false;
  const close = async () => {
    if (anchorCreated) {
      const owned = JSON.parse(await docker('inspect', anchor))[0];
      assert.equal(
        owned.Config.Labels['com.campus-commander.qualification'],
        project,
      );
      await docker('rm', '-f', anchor);
      anchorCreated = false;
    }
    if (volumeCreated) {
      const owned = JSON.parse(await docker('volume', 'inspect', name))[0];
      assert.equal(owned.Labels['com.campus-commander.qualification'], project);
      assert.equal(owned.Options.type, 'tmpfs');
      assert.equal(owned.Options.o, 'size=16m,uid=1000,gid=1000,mode=0700');
      await docker('volume', 'rm', name);
      volumeCreated = false;
    }
  };
  try {
    await docker(
      'volume',
      'create',
      '--label',
      `com.campus-commander.qualification=${project}`,
      '--opt',
      'type=tmpfs',
      '--opt',
      'device=tmpfs',
      '--opt',
      'o=size=16m,uid=1000,gid=1000,mode=0700',
      name,
    );
    volumeCreated = true;
    await docker(
      'run',
      '-d',
      '--name',
      anchor,
      '--label',
      `com.campus-commander.qualification=${project}`,
      '--network',
      'none',
      '--read-only',
      '--user',
      '1000:1000',
      '--cap-drop=ALL',
      '--mount',
      `type=volume,source=${name},target=/volume,volume-nocopy`,
      '--entrypoint',
      'node',
      image,
      '-e',
      'setInterval(()=>{},60000)',
    );
    anchorCreated = true;
    await docker(
      'exec',
      anchor,
      'node',
      '-e',
      "require('node:fs').mkdirSync('/volume/artifacts',{mode:0o700})",
    );
    const execute = promisify(execFile);
    const realDocker = (await execute('which', ['docker'])).stdout.trim();
    const bin = join(root, 'capacity-bin');
    await mkdir(bin, { mode: 0o700 });
    await writeFile(
      join(bin, 'docker'),
      `#!${process.execPath}
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2),run=args.indexOf('run'),nameIndex=args.indexOf('--name');
if(run>=0&&args.includes(${JSON.stringify('io.x-k8s.kind.cluster=' + project)})&&nameIndex>=0&&args[nameIndex+1].startsWith(${JSON.stringify(project + '-')}))args.splice(run+1,0,'--mount',${JSON.stringify('type=volume,source=' + name + ',target=/var/local/cc-synthetic-shared/campus-artifacts,volume-nocopy')});
const result=spawnSync(${JSON.stringify(realDocker)},args,{stdio:'inherit'});process.exit(result.status??1);
`,
      { mode: 0o700 },
    );
    const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const observed = JSON.parse(
      await docker(
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--user',
        '1000:1000',
        '--mount',
        `type=volume,source=${name},target=/volume,readonly,volume-nocopy`,
        '--entrypoint',
        'node',
        image,
        '-e',
        "const fs=require('node:fs'),s=fs.statfsSync('/volume/artifacts');console.log(JSON.stringify({type:s.type,totalBytes:s.blocks*s.bsize}))",
      ),
    );
    assert.equal(observed.type, 0x01021994);
    assert.equal(observed.totalBytes, 16777216);
    const probe = JSON.parse(
      (
        await execute(
          join(bin, 'docker'),
          [
            'run',
            '--rm',
            '--name',
            `${project}-probe`,
            '--label',
            `io.x-k8s.kind.cluster=${project}`,
            '--network',
            'none',
            '--read-only',
            '--user',
            '1000:1000',
            '--entrypoint',
            'node',
            image,
            '-e',
            "const fs=require('node:fs'),s=fs.statfsSync('/var/local/cc-synthetic-shared/campus-artifacts/artifacts');console.log(JSON.stringify({type:s.type,totalBytes:s.blocks*s.bsize}))",
          ],
          { timeout: 30000 },
        )
      ).stdout,
    );
    assert.deepEqual(probe, observed);
    return { name, anchor, close, environment };
  } catch (error) {
    await close();
    throw error;
  }
}
