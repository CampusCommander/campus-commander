import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { installationSecretPath } from './secrets.mjs';
import { runCommand, verifyGeneratedManifests } from './orchestrator.mjs';
import { OnboardingError } from './google-client.mjs';
import { privateTerminalOutput } from './private-output.mjs';
import { withProgress } from './progress.mjs';

export async function applicationAccess(operator, input, run = runCommand) {
  const root = operator.installationRoot;
  const config = JSON.parse(await readFile(operator.configurationPath, 'utf8'));
  const state = JSON.parse(
    await readFile(join(root, 'installer-state.json'), 'utf8'),
  );
  const kubernetes = config.profile === 'kubernetes';
  const project = kubernetes ? operator.kubernetes.namespace : operator.project;
  await verifyGeneratedManifests({ root, state, project });
  const command = [
    'node',
    '/app/deployment/bootstrap/application-access-cli.mjs',
  ];
  if (!kubernetes) {
    const result = await run(
      'docker',
      [
        'compose',
        '-f',
        join(root, 'docker-compose.json'),
        '-p',
        project,
        'run',
        '--rm',
        '--no-deps',
        '--interactive',
        '--no-tty',
        'database-migrate',
        ...command,
        '/run/config/profile.json',
        '/run/config/operator.json',
        '/dev/stdin',
      ],
      { input: JSON.stringify(input) },
    );
    return JSON.parse(result);
  }
  const manifest = JSON.parse(
    await readFile(join(root, 'kubernetes.json'), 'utf8'),
  );
  const template = structuredClone(
    manifest.items.find(
      (item) =>
        item.kind === 'Job' &&
        item.metadata.name.startsWith('database-prepare-'),
    )?.spec.template,
  );
  if (!template || !operator.cluster.context)
    throw new OnboardingError(
      'The verified Kubernetes migration configuration is missing. Resume service preparation.',
    );
  const name = `cc-enrollment-${randomUUID()}`;
  template.spec.containers[0].command = [
    'node',
    '-e',
    'setTimeout(() => process.exit(1), 180000)',
  ];
  template.spec.activeDeadlineSeconds = 180;
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { ...template.metadata, name, namespace: project },
    spec: template.spec,
  };
  const kube = (args, input) =>
    run(
      'kubectl',
      ['--context', operator.cluster.context, '-n', project, ...args],
      { input },
    );
  let created = false;
  try {
    await kube(['create', '-f', '-'], JSON.stringify(pod));
    created = true;
    await kube([
      'wait',
      '--for=condition=Ready',
      `pod/${name}`,
      '--timeout=120s',
    ]);
    return JSON.parse(
      await kube(
        [
          'exec',
          '-i',
          name,
          '--',
          ...command,
          '/config/deployment.json',
          '/config/operator.json',
          '/dev/stdin',
        ],
        JSON.stringify(input),
      ),
    );
  } finally {
    if (created) await kube(['delete', 'pod', name, '--ignore-not-found=true']);
  }
}

export async function operatorEnrollmentRequest(config, operator, payload) {
  const root = join(operator.installationRoot, 'private');
  const edge = config.services.edge;
  const caRef =
    edge.endpoint.tls.mode === 'private-ca'
      ? edge.endpoint.tls.caSecretRef
      : undefined;
  const ca = caRef
    ? await readFile(installationSecretPath(root, caRef))
    : JSON.parse(
          await readFile(
            join(operator.installationRoot, 'setup-record.json'),
            'utf8',
          ),
        ).selfSignedCertificate
      ? await readFile(
          installationSecretPath(root, edge.serverTls.certificateSecretRef),
        )
      : undefined;
  const bootstrap = (
    await readFile(
      installationSecretPath(root, edge.bootstrapSecretRef),
      'utf8',
    )
  ).trim();
  const target = new URL(
    '/api/auth/enrollment/operator',
    config.applicationAuth.publicOrigin,
  );
  const bytes = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(
        new OnboardingError(
          'Administrator enrollment is unavailable. Check service readiness and resume the installer.',
        ),
      );
    const request = https.request(
      target,
      {
        method: 'POST',
        ca,
        rejectUnauthorized: true,
        ...(operator.connectAddress
          ? { hostname: operator.connectAddress, servername: target.hostname }
          : {}),
        headers: {
          host: target.host,
          'content-type': 'application/json',
          'content-length': bytes.length,
          authorization: `Basic ${Buffer.from(`operator:${bootstrap}`).toString('base64')}`,
        },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 16384) response.destroy();
        });
        response.on('error', fail);
        response.on('end', () => {
          if (response.statusCode !== 200 && response.statusCode !== 201)
            return fail();
          try {
            resolve(JSON.parse(body));
          } catch {
            fail();
          }
        });
      },
    );
    request.on('error', fail);
    request.setTimeout(10000, () => request.destroy());
    request.end(bytes);
  });
}

const candidate = z.strictObject({
  issuer: z.string(),
  subject: z.string().min(1).max(512),
  displayName: z.string().min(1).max(200),
});
export async function enrollAdministrator({
  config,
  operator,
  ask,
  output,
  privateOutput = privateTerminalOutput,
  access = applicationAccess,
  request = operatorEnrollmentRequest,
  pause = delay,
}) {
  const existing = await withProgress(
    () => access(operator, { action: 'inspect' }),
    output,
    'checking administrator enrollment',
  );
  if (!Array.isArray(existing.principals))
    throw new OnboardingError(
      'Administrator inspection returned an invalid result. Preserve the installation and retry.',
    );
  if (existing.principals.length) {
    output(
      'Administrator enrollment already completed. Existing access remains unchanged.',
    );
    return { status: 'already-enrolled' };
  }
  if (!ask) {
    output(
      'Administrator enrollment is pending. Resume in a terminal to complete guided sign-in.',
    );
    return { status: 'pending' };
  }
  await request(config, operator, { action: 'cancel' });
  const attempt = z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      code: z.string().regex(/^[a-f0-9]{64}$/),
      expires: z.number(),
    })
    .parse(await request(config, operator, { action: 'start' }));
  output(
    `Administrator setup page: ${config.applicationAuth.publicOrigin}/setup`,
  );
  try {
    privateOutput(`Private administrator pairing code: ${attempt.code}`);
    output(
      'Open the setup page in your browser. Enter the pairing code and select the administrator account.',
    );
    while (Date.now() < attempt.expires) {
      const status = await request(config, operator, {
        action: 'inspect',
        id: attempt.id,
      });
      if (status.status === 'failed')
        throw new OnboardingError(
          'Administrator sign-in failed. Resume the installer and retry with a new pairing code.',
        );
      if (status.status === 'verified') {
        const identity = candidate.parse(status.candidate);
        if (identity.issuer !== config.applicationAuth.issuer)
          throw new OnboardingError(
            'The verified identity has a different issuer. Restart enrollment.',
          );
        // JSON encoding prevents provider-controlled terminal escape sequences.
        output(
          `Verified administrator: ${JSON.stringify(identity.displayName)}. Provider subject: ${JSON.stringify(identity.subject)}.`,
        );
        if (
          (
            await ask(
              'Grant initial administrator access to this verified account (yes/no) [no]: ',
            )
          )
            .trim()
            .toLowerCase() !== 'yes'
        ) {
          output(
            'Administrator enrollment cancelled. Resume the installer when ready.',
          );
          return { status: 'cancelled' };
        }
        const claimed = await request(config, operator, {
          action: 'claim',
          id: attempt.id,
        });
        const verified = candidate.parse(claimed.candidate);
        if (JSON.stringify(verified) !== JSON.stringify(identity))
          throw new OnboardingError(
            'The verified identity changed. Restart enrollment.',
          );
        const result = await withProgress(
          () =>
            access(operator, {
              action: 'initialize',
              ...verified,
            }),
          output,
          'saving administrator access',
        );
        output(
          `Administrator enrollment completed. Support reference: ${z.string().uuid().parse(result.correlationId)}.`,
        );
        return { status: 'enrolled', principalId: result.principalId };
      }
      output(
        'Waiting for administrator sign-in. Keep the browser and installer open.',
      );
      await pause(3000);
    }
    throw new OnboardingError(
      'Administrator enrollment expired. Resume the installer for a new pairing code.',
    );
  } finally {
    await request(config, operator, { action: 'cancel', id: attempt.id }).catch(
      () => undefined,
    );
  }
}
