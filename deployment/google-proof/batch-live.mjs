/**
 * Read-only live check of the Google batch service against the approved Easton fixture.
 * Run: node --import ./libs/application-contracts/test-register.mjs deployment/google-proof/batch-live.mjs [key-file]
 * It batches orgunits.get for up to two real OUs and one missing path, then writes sanitized evidence.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  GoogleBatchService,
  validateServiceAccount,
} from '@campus/google-connection';
import { scopedClient } from '../../libs/google-connection/src/lib/provider.ts';

const customerId = 'C01zcarnq';
const subject = 'spencer@easton-consulting.com';
const clientId = '113794681976879482895';
const scope =
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly';
const directory = `/admin/directory/v1/customer/${customerId}/orgunits`;
const keyPath =
  process.argv[2] ?? '/mnt/c/Users/spenc/Downloads/DWD_SA_CC.json';

const credential = {
  subject,
  serviceAccount: validateServiceAccount(
    JSON.parse(await readFile(keyPath, 'utf8')),
    clientId,
  ),
};
const signal = AbortSignal.timeout(120_000);
const client = await scopedClient(credential, scope, signal);
const listed = await client.request({
  url: `https://admin.googleapis.com${directory}`,
  method: 'GET',
  params: { type: 'all', fields: 'organizationUnits(orgUnitId)' },
});
const ouIds = (listed.data.organizationUnits ?? [])
  .map((unit) => unit.orgUnitId)
  .filter((id) => typeof id === 'string' && /^id:[A-Za-z0-9]+$/.test(id))
  .slice(0, 2);

const requests = [
  ...ouIds.map((id, index) => ({
    id: `ou-${index + 1}`,
    method: 'GET',
    path: `${directory}/${id}`,
    query: { fields: 'orgUnitId' },
  })),
  {
    id: 'missing',
    method: 'GET',
    path: `${directory}/cc-batch-missing-probe`,
    query: { fields: 'orgUnitId' },
  },
];
const rounds = [];
const started = Date.now();
const result = await new GoogleBatchService().execute({
  batchUrl: 'https://www.googleapis.com/batch/admin/directory_v1',
  requests,
  // A page matches when Google answered the OU this part asked for. This proves Content-ID mapping.
  parse: (body, request) => ({
    matched: request.path.endsWith(`/${body?.orgUnitId}`),
  }),
  getClient: (runSignal) => scopedClient(credential, scope, runSignal),
  signal,
  onBatch: (event) =>
    void rounds.push({
      sentCount: event.sentCount,
      outerStatus: event.outerStatus,
      pending: event.pending,
    }),
});

const outcome = (id) => {
  const pages = result.succeeded.get(id);
  if (pages) return { kind: 'success', contentIdMatched: pages[0].matched };
  const failed = result.failed.get(id);
  return { kind: failed.kind, status: failed.status, reason: failed.reason };
};
const recordedAt = new Date().toISOString();
const evidence = {
  recordedAt,
  fixture: 'approved Easton read-only fixture',
  scope,
  method:
    'directory.orgunits.get through https://www.googleapis.com/batch/admin/directory_v1',
  ouCount: ouIds.length,
  rounds,
  outcomes: Object.fromEntries(
    requests.map((request) => [request.id, outcome(request.id)]),
  ),
  durationMs: Date.now() - started,
  limitations: [
    'Paging is not exercised. No authorized live scope returns page tokens.',
  ],
};
const path = `deployment/evidence/batch-service-live-${recordedAt.slice(0, 10)}.json`;
await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
console.log(`Evidence written to ${path}`);
