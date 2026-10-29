import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import esbuild from 'esbuild';

/**
 * Execute of one import plan (design section 7, card XBA, row A2). The suite runs the real
 * controller, the real import services, the real `AuthGuard`, and the real exception filter against
 * a fake database, store, and admission. The database double holds the plan rows, the previews, and
 * the jobs of one Execute, so a refused link rolls back the state that the confirmations created.
 *
 * The double applies the bind rule of PostgreSQL and the bounds of the plan functions: one target
 * page carries 250 targets, one mark call carries 250 devices and 250 reasons, and the link refuses
 * a change that holds neither a link nor a reason.
 *
 * `device-imports.test.mjs` compiles the TypeScript the same way, because Node's type stripping does
 * not transform the Nest decorators.
 */
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') && url.includes('/api/src/')) {
      const file = fileURLToPath(url);
      const { code } = esbuild.transformSync(readFileSync(file, 'utf8'), {
        loader: 'ts',
        format: 'esm',
        target: 'node22',
        tsconfigRaw: {
          compilerOptions: {
            experimentalDecorators: true,
            useDefineForClassFields: false,
          },
        },
        sourcefile: file,
      });
      return { format: 'module', shortCircuit: true, source: code };
    }
    return nextLoad(url, context);
  },
});

const require = createRequire(import.meta.url);
const { ForbiddenException, Module } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { Reflector } = require('@nestjs/core');

const customer = 'C0123456';
const otherCustomer = 'C0654321';
const actor = '11111111-1111-4111-8111-111111111111';
const jobId = '44444444-4444-4444-8444-444444444444';
const planId = '66666666-6666-4666-8666-666666666666';
const HOUR = 60 * 60 * 1000;
/** A fixture time relative to the clock of the run. The plan lives one hour (design section 7). */
const at = (offsetMs = 0) => new Date(Date.now() + offsetMs);

/** The bind rule of PostgreSQL: one value for each named parameter, with no gap. */
function assertBound(text, values) {
  const named = new Set();
  for (const match of text.matchAll(/\$(\d+)/g)) named.add(Number(match[1]));
  const highest = Math.max(0, ...named);
  assert.equal(
    values.length,
    highest,
    `The statement binds ${values.length} values for ${highest} parameters: ${text}`,
  );
  for (let index = 1; index <= highest; index += 1)
    assert.ok(named.has(index), `The statement skips parameter $${index}.`);
}

const session = {
  identity: {
    id: actor,
    displayName: 'Test person',
    permissions: [],
    permissionVersion: 7,
    grants: [],
    preferences: {},
  },
  expiresAt: at(HOUR).toISOString(),
  csrfToken: 'a'.repeat(64),
};
const connected = { customerId: customer, generation: 3 };

/** The status actions whose reason a change carries (design section 3). */
const STATUS_REASONS = [
  'status-unknown',
  'device-deprovisioned',
  'device-active',
  'device-disabled',
];

/** The job action of each preview action, as the route answers it. */
const JOB_ACTION = {
  'annotated-location': 'update-device-annotations',
  disable: 'disable-devices',
  reenable: 'reenable-devices',
  deprovision: 'deprovision-devices',
};

/** The status permissions that the job recorded at submission. */
let statusPermissions;
/** The plan of the job, as the routes read it. */
let plan;
/** The change rows of the plan, mutated by the mark and link calls. */
let changes;
/** The devices of the inventory, by device ID. */
let devices;
/** The person rows of the plan changes. */
let people;
/** The answer of `cc.lock_device_import_plan`. */
let lockResult;
/** Whether the job reads as visible to the signed-in person. */
let jobVisible;
/** Whether the link call refuses, as an incomplete link refuses in 017-jobs.sql. */
let linkRefuses;
/** The previews of the current test, by preview ID. */
let previews;
/** The jobs that the confirmations created. */
let createdJobs;
/** The plan state after the last link. */
let planState;
/** The recorded statements and their values. */
let statements;
/** The pages that the add call received, in order. */
let addedPages;
/** The digests that the seal call received, by preview ID. */
let sealedDigests;
/** The artifacts that the store staged, in order. */
let artifacts;
/** The confirmations that ran, in order. */
let confirmations;
/** The commits and rollbacks of the fake transaction. */
let transactions;
/** The actions that the signed-in person holds. */
let allowed;
/** The action checks that the route ran, in order. */
let checks;
/** The admissions that ran after the commit. */
let admissions;
/** Header checks that the guard refused. */
let denied;

let app;
let origin;
/** The plan modules under test. */
let executeModule;
let manifestDigest;
let editPreviewTargets;
let actionManifestDigest;
let actionTargets;

const importActions = ['devices:read', 'devices:write', 'devices:bulk-actions'];

/** One device row of `cc.devices`, as the page statement joins it. */
function deviceRow(deviceId, overrides = {}) {
  return {
    device_id: deviceId,
    serial_number: `SN-${deviceId}`,
    org_unit_path: '/School A',
    annotated_location: null,
    asset_tag: null,
    annotated_user: null,
    notes: null,
    status: 'ACTIVE',
    status_observed_at: at(-HOUR).toISOString(),
    last_entity_sync: at(-HOUR).toISOString(),
    removed_at: null,
    ...overrides,
  };
}

/** One field change row of the plan. */
function fieldChange(ordinal, deviceId, overrides = {}) {
  return {
    ordinal,
    source_row: ordinal + 1,
    device_id: deviceId,
    change_type: 'field',
    field: 'notes',
    mode: 'replace',
    status_action: null,
    deprovision_reason: null,
    current_value: null,
    new_value: `Note ${deviceId}`,
    not_run_reason: null,
    linked_job_id: null,
    operation_number: null,
    ...overrides,
  };
}

/** One status change row of the plan. */
function statusChange(ordinal, deviceId, action, overrides = {}) {
  return {
    ordinal,
    source_row: ordinal + 1,
    device_id: deviceId,
    change_type: 'status',
    field: null,
    mode: null,
    status_action: action,
    deprovision_reason:
      action === 'deprovision' ? 'DEPROVISION_REASON_RETIRING_DEVICE' : null,
    current_value: 'ACTIVE',
    new_value: action === 'disable' ? 'DISABLED' : 'ACTIVE',
    not_run_reason: null,
    linked_job_id: null,
    operation_number: null,
    ...overrides,
  };
}

/** The plan row of the job, as the lock answers it. */
function sqlPlan(overrides = {}) {
  return {
    planId,
    revision: 1,
    state: 'open',
    expiresAt: at(HOUR).toISOString(),
    changedBy: null,
    changedAt: null,
    ...overrides,
  };
}

const storedReceipt = (job, status = 'accepted') => ({
  jobId: job.jobId,
  displayId: job.displayId,
  status,
  deviceCount: job.deviceCount,
  updateCount: job.deviceCount,
});

const ids = (list) => list.map((value) => String(value));
/** A jsonb value as the client binds it: one JSON text or one array. */
const jsonb = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;
/** The device ID order of the plan read: the JavaScript order of plain IDs. */
const collateC = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** Reset every fixture to one open plan of one eligible field change. */
function reset({ actions, recordedStatuses = null } = {}) {
  // The permission that each status action requires, and the actions of the plan.
  statusPermissions = recordedStatuses;
  plan = sqlPlan();
  planState = 'open';
  changes = [fieldChange(0, 'dev-a')];
  devices = new Map([['dev-a', deviceRow('dev-a')]]);
  people = new Map([[actor, { id: actor, display_name: 'Test person' }]]);
  lockResult = { outcome: 'locked', plan: sqlPlan() };
  jobVisible = true;
  linkRefuses = false;
  previews = new Map();
  createdJobs = [];
  statements = [];
  addedPages = [];
  sealedDigests = new Map();
  artifacts = [];
  confirmations = [];
  transactions = [];
  admissions = [];
  checks = [];
  denied = [];
  allowed = new Set(
    actions ?? [...importActions, 'devices:status', 'devices:deprovision'],
  );
}

/** One page of the plan, with the current values of each device, as the page statement answers. */
function pageRows(values) {
  const [, after, limit] = values;
  const order = [...new Set(changes.map((row) => row.device_id))].sort(
    collateC,
  );
  const page = order
    .filter((deviceId) => after === null || collateC(deviceId, after) > 0)
    .slice(0, limit);
  const wanted = new Set(page);
  return changes
    .filter((row) => wanted.has(row.device_id))
    .sort(
      (left, right) =>
        collateC(left.device_id, right.device_id) ||
        left.ordinal - right.ordinal,
    )
    .map((row) => {
      const device = devices.get(row.device_id) ?? {};
      return {
        device_id: row.device_id,
        ordinal: row.ordinal,
        change_type: row.change_type,
        field: row.field,
        mode: row.mode,
        status_action: row.status_action,
        deprovision_reason: row.deprovision_reason,
        current_value: row.current_value,
        new_value: row.new_value,
        not_run_reason: row.not_run_reason,
        linked_job_id: row.linked_job_id,
        found_device_id: device.device_id ?? null,
        serial_number: device.serial_number ?? null,
        org_unit_path: device.org_unit_path ?? null,
        annotated_location: device.annotated_location ?? null,
        asset_tag: device.asset_tag ?? null,
        annotated_user: device.annotated_user ?? null,
        notes: device.notes ?? null,
        status: device.status ?? null,
        status_observed_at: device.status_observed_at ?? null,
        last_entity_sync: device.last_entity_sync ?? null,
        removed_at: device.removed_at ?? null,
      };
    });
}

/** The plan row that the mark call changes, as `cc.mark_device_import_changes` changes it. */
function markAnswer(values) {
  const [, , , , , devices, reasons] = values;
  const markedDevices = jsonb(devices);
  const dispositions = jsonb(reasons);
  assert.ok(markedDevices.length <= 250, 'One mark call names 250 devices.');
  assert.ok(dispositions.length <= 250, 'One mark call names 250 reasons.');
  assert.equal(
    new Set(markedDevices).size,
    markedDevices.length,
    'One mark call repeats no device.',
  );
  let marked = 0;
  let disposed = 0;
  for (const row of changes) {
    if (
      markedDevices.includes(row.device_id) &&
      row.linked_job_id === null &&
      row.not_run_reason === null
    ) {
      row.not_run_reason = 'changed-after-validation';
      marked += 1;
    }
  }
  for (const disposition of dispositions) {
    const row = changes.find((one) => one.ordinal === disposition.ordinal);
    if (row && row.linked_job_id === null && row.not_run_reason === null) {
      row.not_run_reason = disposition.reason;
      disposed += 1;
    }
  }
  return { outcome: 'marked', marked, disposed };
}

/** The preview row of one open or sealed preview. */
function previewRow(preview) {
  return {
    preview_id: preview.preview_id,
    display_id: preview.display_id,
    customer_id: preview.customer_id,
    created_by: preview.created_by,
    permission_version: preview.permission_version,
    generation: preview.generation,
    action: preview.action,
    deprovision_reason: preview.deprovision_reason,
    selected: preview.selected,
    eligible: preview.eligible,
    unchanged: preview.unchanged,
    excluded: preview.excluded,
    conflicts: preview.conflicts,
    field_changes: preview.field_changes,
    oldest_observed_at: preview.oldest_observed_at,
    prepared_at: preview.prepared_at,
    expires_at: preview.expires_at,
    manifest_digest: preview.manifest_digest,
  };
}

/** The preview that the open call creates, as `cc.open_device_update_preview` creates it. */
function openAnswer(values) {
  const [, version, customerId, generation, action, , minutes, reason] = values;
  const preview = {
    preview_id: randomUUID(),
    display_id: `PV-${String(previews.size + 1).padStart(3, '0')}`,
    customer_id: customerId,
    created_by: actor,
    permission_version: version,
    generation,
    action,
    deprovision_reason: reason,
    selected: 0,
    eligible: 0,
    unchanged: 0,
    excluded: 0,
    conflicts: 0,
    field_changes: 0,
    oldest_observed_at: null,
    prepared_at: at().toISOString(),
    expires_at: at(minutes * 60 * 1000).toISOString(),
    manifest_digest: null,
    targets: [],
  };
  previews.set(preview.preview_id, preview);
  return { outcome: 'opened', preview: previewRow(preview) };
}

/** The seal of one filled preview, as `cc.seal_device_update_preview` writes it. */
function sealAnswer(values) {
  const [, , , previewId, digest] = values;
  const preview = previews.get(previewId);
  assert.ok(preview, 'A seal names one preview of this Execute.');
  preview.selected = preview.targets.length;
  preview.eligible = preview.targets.filter(
    (target) => target.disposition === 'eligible',
  ).length;
  preview.conflicts = preview.targets.filter(
    (target) => target.disposition === 'conflict',
  ).length;
  preview.field_changes = preview.targets.reduce(
    (count, target) =>
      count +
      (target.fields ?? []).filter((field) => field.disposition === 'eligible')
        .length,
    0,
  );
  preview.manifest_digest = digest;
  sealedDigests.set(previewId, digest);
  return { outcome: 'sealed', preview: previewRow(preview) };
}

/** One manifest page, as `cc.read_device_update_preview_manifest_page` answers it. */
function manifestAnswer(values) {
  const [, , , previewId, afterOrdinal] = values;
  const preview = previews.get(previewId);
  const ordered = preview.targets
    .filter((target) => afterOrdinal === null || target.ordinal > afterOrdinal)
    .sort((left, right) => left.ordinal - right.ordinal);
  const page = ordered.slice(0, 250);
  assert.ok(page.length <= 250, 'One manifest read answers 250 targets.');
  return {
    outcome: 'page',
    // One stored target as the read answers it: the keys that the add call wrote, in that order.
    targets: page.map((target) => ({
      ordinal: target.ordinal,
      device_id: target.device_id,
      serial_number: target.serial_number,
      org_unit_path: target.org_unit_path,
      observed_at: target.observed_at,
      disposition: target.disposition,
      exclusion_reason: target.exclusion_reason,
      fields: (target.fields ?? []).map((field) => ({
        field: field.field,
        requestedValue: field.requested_value,
        observedValue: field.observed_value,
        baselineValue: field.baseline_value,
        disposition: field.disposition,
      })),
    })),
    nextOrdinal: page.length === 250 ? page[page.length - 1].ordinal : null,
    total: preview.targets.length,
    manifestDigest: preview.manifest_digest,
  };
}

/** The job that one confirmation creates, as `cc.confirm_device_update_preview` creates it. */
function confirmAnswer(values) {
  const [, , customerId, previewId, digest, artifactId, , phrase] = values;
  const preview = previews.get(previewId);
  assert.ok(preview, 'A confirmation names one preview of this Execute.');
  assert.equal(
    digest,
    preview.manifest_digest,
    'The seal digest is confirmed.',
  );
  assert.ok(artifactId, 'The confirmation names a stored manifest.');
  assert.equal(
    phrase,
    preview.action === 'deprovision' ? 'DEPROVISION' : null,
    'Only a Deprovision confirmation carries the phrase.',
  );
  const eligible = preview.targets.filter(
    (target) => target.disposition === 'eligible',
  );
  assert.ok(eligible.length > 0, 'An empty preview never confirms.');
  const job = {
    jobId: randomUUID(),
    displayId: `${preview.action === 'annotated-location' ? 'UPD' : 'STS'}-${String(createdJobs.length + 1).padStart(3, '0')}`,
    // cc.device_update_jobs.action holds the preview action, not the job action.
    action: preview.action,
    deviceCount: eligible.length,
    customerId,
  };
  createdJobs.push(job);
  preview.job = job;
  confirmations.push({ previewId, phrase, digest });
  return {
    outcome: 'created',
    // The stored receipt of `cc.device_update_receipt` holds no action, and the route adds it.
    receipt: storedReceipt(job),
  };
}

/** The links, the waits, and the executed plan, as `cc.link_device_import_jobs` writes them. */
function linkAnswer(values) {
  const [, , , , linkedPlanId, previewIds, notRun] = values;
  assert.ok(
    previewIds.length >= 1 && previewIds.length <= 7,
    'One Execute links one to seven previews.',
  );
  assert.deepEqual(notRun, [], 'The reasons of the plan are already stored.');
  if (linkRefuses) throw new Error('The import links are incomplete.');
  const runs = previewIds.map((previewId) => {
    const preview = previews.get(previewId);
    assert.ok(preview?.job, 'Every linked preview holds a job.');
    return preview;
  });
  for (const row of changes) {
    if (row.linked_job_id !== null || row.not_run_reason !== null) continue;
    const run = runs.find(
      (preview) =>
        preview.targets.some(
          (target) =>
            target.device_id === row.device_id &&
            target.disposition === 'eligible',
        ) &&
        (row.change_type === 'field'
          ? preview.action === 'annotated-location'
          : preview.action === row.status_action),
    );
    // 017-jobs.sql raises when a change holds neither a link nor a reason.
    if (!run) throw new Error('The import links are incomplete.');
    row.linked_job_id = run.job.jobId;
    row.operation_number = 1;
  }
  planState = 'executed';
  plan = sqlPlan({
    revision: plan.revision + 1,
    state: 'executed',
    changedBy: actor,
    changedAt: at().toISOString(),
  });
  return {
    outcome: 'executed',
    plan: plan,
    receipts: runs.map((preview) => storedReceipt(preview.job)),
    linked: changes.filter((row) => row.linked_job_id !== null).length,
  };
}

/** The counts of the changes that Execute left out, as the answer counts them. */
function countsAnswer() {
  return {
    conflicts: changes.filter(
      (row) => row.not_run_reason === 'changed-after-validation',
    ).length,
    excluded: changes.filter((row) =>
      STATUS_REASONS.includes(row.not_run_reason),
    ).length,
  };
}

/** One job row of the plan, as both job statements join it. */
function jobAnswer(customerId, displayId, width) {
  if (displayId !== 'IMP-001' || customerId !== customer || !jobVisible)
    return { rows: [] };
  const recorded =
    statusPermissions ??
    ['disable', 'reenable', 'deprovision'].filter((action) =>
      changes.some(
        (row) => row.change_type === 'status' && row.status_action === action,
      ),
    );
  const row = {
    job_id: jobId,
    display_id: 'IMP-001',
    requested_by: actor,
    plan_id: plan.planId,
    plan_revision: plan.revision,
    plan_state: planState,
    plan_expires_at: plan.expiresAt,
    plan_changed_at: plan.changedAt,
    plan_changed_by_id: plan.changedBy,
    plan_changed_by_name: plan.changedBy
      ? people.get(plan.changedBy)?.display_name
      : null,
  };
  return {
    rows: [
      width === 'wide'
        ? {
            ...row,
            status: 'completed',
            visible: true,
            status_permissions: recorded,
          }
        : row,
    ],
  };
}

before(async () => {
  const [
    controllerModule,
    importsServiceModule,
    executeServiceModule,
    devicesModule,
    authModule,
    guardModule,
    securityModule,
    updatesModule,
    actionsModule,
  ] = await Promise.all([
    import('./device-imports.controller.ts'),
    import('./device-imports.service.ts'),
    import('./device-import-execute.service.ts'),
    import('./devices.service.ts'),
    import('../auth/auth.service.ts'),
    import('../auth/auth.guard.ts'),
    import('../security.ts'),
    import('./device-updates.ts'),
    import('./device-actions.ts'),
  ]);
  const { DeviceImportsController } = controllerModule;
  const { DeviceImportsService } = importsServiceModule;
  const { DeviceImportExecuteService } = executeServiceModule;
  const { DevicesService } = devicesModule;
  const { AuthService } = authModule;
  const { AuthGuard } = guardModule;
  const { ApplicationExceptionFilter, securityHeaders } = securityModule;
  manifestDigest = updatesModule.manifestDigest;
  editPreviewTargets = updatesModule.editPreviewTargets;
  actionManifestDigest = actionsModule.actionManifestDigest;
  actionTargets = actionsModule.actionTargets;

  reset();

  const answer = (text, values) => {
    if (text.includes('cc.lock_device_import_plan')) {
      if (lockResult.outcome === 'locked') lockResult = { ...lockResult, plan };
      return { rows: [{ result: lockResult }] };
    }
    if (text.includes('cc.mark_device_import_changes'))
      return { rows: [{ result: markAnswer(values) }] };
    if (text.includes('cc.open_device_update_preview'))
      return { rows: [{ result: openAnswer(values) }] };
    if (text.includes('cc.add_device_update_preview_targets')) {
      const [, , , previewId, document] = values;
      const targets = jsonb(document);
      assert.ok(targets.length <= 250, 'One add call carries one page.');
      const preview = previews.get(previewId);
      addedPages.push({ previewId, action: preview.action, page: targets });
      preview.targets.push(...targets);
      return {
        rows: [
          {
            result: {
              outcome: 'added',
              added: targets.length,
              targets: preview.targets.length,
            },
          },
        ],
      };
    }
    if (text.includes('cc.seal_device_update_preview'))
      return { rows: [{ result: sealAnswer(values) }] };
    if (text.includes('cc.read_device_update_preview_manifest_page'))
      return { rows: [{ result: manifestAnswer(values) }] };
    if (text.includes('cc.confirm_device_update_preview'))
      return { rows: [{ result: confirmAnswer(values) }] };
    if (text.includes('cc.link_device_import_jobs'))
      return { rows: [{ result: linkAnswer(values) }] };
    if (text.includes('FROM page p')) return { rows: pageRows(values) };
    if (text.includes("change_type='status' AND status_action='deprovision'"))
      return {
        rows: [
          {
            rows: changes.filter(
              (row) =>
                row.change_type === 'status' &&
                row.status_action === 'deprovision',
            ).length,
          },
        ],
      };
    if (
      text.includes('FROM cc.device_import_changes WHERE job_id=$1') &&
      text.includes('AS conflicts')
    )
      return { rows: [countsAnswer()] };
    if (text.includes('JOIN cc.device_update_jobs u'))
      return {
        rows: createdJobs
          .filter((job) => ids(values[0]).includes(job.jobId))
          .map((job) => ({ job_id: job.jobId, action: job.action })),
      };
    if (text.includes('i.status_permissions'))
      // `statusActions` binds [actor, version, customer, display ID].
      return jobAnswer(values[2], values[3], 'wide');
    if (text.includes('WHERE j.customer_id=$1 AND j.display_id=$2'))
      // Execute binds [customer, display ID, actor, version].
      return jobAnswer(values[0], values[1], 'narrow');
    if (text.includes('FROM cc.application_principals p WHERE p.id=$1')) {
      const person = people.get(values[0]);
      return { rows: person ? [person] : [] };
    }
    throw new Error(`The test answered no statement: ${text}`);
  };

  const query = async (text, values = []) => {
    statements.push({ text, values });
    assertBound(text, values);
    return answer(text, values);
  };

  /** One transaction that rolls its own writes back, as `DatabaseService.transaction` does. */
  const database = {
    connection: { query },
    transaction: async (run) => {
      const snapshot = {
        changes: changes.map((row) => ({ ...row })),
        previews: new Map(
          [...previews].map(([id, preview]) => [
            id,
            { ...preview, targets: [...preview.targets] },
          ]),
        ),
        jobs: [...createdJobs],
        planState,
        plan: { ...plan },
      };
      try {
        const value = await run({ query });
        transactions.push('commit');
        return value;
      } catch (error) {
        changes = snapshot.changes;
        previews = snapshot.previews;
        createdJobs = snapshot.jobs;
        planState = snapshot.planState;
        plan = snapshot.plan;
        transactions.push('rollback');
        throw error;
      }
    },
  };

  const storage = {
    stageUpload: async () => {
      throw new Error('An import route stages no file here.');
    },
    discardUpload: async () => true,
    storeJsonStream: async (source) => {
      const chunks = [];
      for await (const chunk of source) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      artifacts.push(bytes);
      return `artifact-manifest-${artifacts.length}`;
    },
  };
  const orchestration = { startDeviceImport: async () => 'execution-1' };
  const jobs = {
    admit: async (customerId) => {
      admissions.push(customerId);
      return true;
    },
  };
  const devicesService = {
    sync: async () => {
      if (!allowed.has('devices:read'))
        throw new ForbiddenException({ reason: 'forbidden' });
      return connected;
    },
  };
  const auth = {
    authenticate: async () => session,
    recordDeniedRequest: async (correlationId, actorId) => {
      denied.push({ correlationId, actorId });
    },
    authorize: async (_session, action) => {
      checks.push(action);
      if (!allowed.has(action))
        throw new ForbiddenException(
          'This action requires additional permission.',
        );
    },
  };
  const configuration = {
    auth: {
      get publicOrigin() {
        return origin;
      },
    },
  };
  const guard = new AuthGuard(auth, new Reflector(), configuration);

  Reflect.defineMetadata(
    'design:paramtypes',
    [
      DevicesService,
      DeviceImportsService,
      DeviceImportExecuteService,
      AuthService,
    ],
    DeviceImportsController,
  );

  class ImportRoutesModule {}
  Module({
    controllers: [DeviceImportsController],
    providers: [
      { provide: DevicesService, useValue: devicesService },
      {
        provide: DeviceImportsService,
        useValue: new DeviceImportsService(database, storage, orchestration),
      },
      {
        provide: DeviceImportExecuteService,
        useValue: new DeviceImportExecuteService(database, storage, jobs),
      },
      { provide: AuthService, useValue: auth },
    ],
  })(ImportRoutesModule);

  const moduleRef = await Test.createTestingModule({
    imports: [ImportRoutesModule],
  })
    .overrideGuard(AuthGuard)
    .useValue(guard)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.use(securityHeaders);
  app.useGlobalFilters(new ApplicationExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app?.close();
});

async function post(path, payload) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      origin,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // A refusal that carries no JSON stays text.
  }
  return { status: response.status, body };
}

const executePath = '/api/devices/imports/IMP-001/execute';
const execute = (overrides = {}) =>
  post(executePath, {
    planId,
    planRevision: 1,
    typedPhrase: null,
    ...overrides,
  });

const statementsOf = (fragment) =>
  statements.filter((statement) => statement.text.includes(fragment));

test('an execute fills one edit preview, links each change, and answers its receipts', async () => {
  reset();
  const answer = await execute();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.plan.state, 'executed');
  assert.equal(answer.body.plan.revision, 2);
  assert.equal(answer.body.conflicts, 0);
  assert.equal(answer.body.excluded, 0);
  assert.deepEqual(
    answer.body.receipts.map((one) => one.action),
    ['update-device-annotations'],
  );
  assert.equal(answer.body.receipts[0].deviceCount, 1);
  assert.equal(answer.body.receipts[0].status, 'accepted');
  assert.equal(createdJobs.length, 1, 'One Execute creates one job here.');
  assert.equal(planState, 'executed');
  assert.equal(changes[0].linked_job_id, createdJobs[0].jobId);
  assert.deepEqual(
    transactions,
    ['commit'],
    'Every step runs in one transaction.',
  );
  assert.deepEqual(
    admissions,
    [customer],
    'The handler admits after the commit.',
  );
  // The steps of design section 7 run in order, and the link comes after every confirmation.
  assert.deepEqual(
    statements.map((statement) => {
      if (statement.text.includes('cc.lock_device_import_plan')) return 'lock';
      if (statement.text.includes('cc.mark_device_import_changes'))
        return 'mark';
      if (statement.text.includes('cc.open_device_update_preview'))
        return 'open';
      if (statement.text.includes('cc.add_device_update_preview_targets'))
        return 'add';
      if (statement.text.includes('cc.seal_device_update_preview'))
        return 'seal';
      if (
        statement.text.includes('cc.read_device_update_preview_manifest_page')
      )
        return 'manifest';
      if (statement.text.includes('cc.confirm_device_update_preview'))
        return 'confirm';
      if (statement.text.includes('cc.link_device_import_jobs')) return 'link';
      if (
        statement.text.includes('i.status_permissions') ||
        statement.text.includes('WHERE j.customer_id=$1 AND j.display_id=$2')
      )
        return 'job';
      if (statement.text.includes("status_action='deprovision'"))
        return 'phrase';
      if (statement.text.includes('FROM page p')) return 'page';
      if (statement.text.includes('AS conflicts')) return 'counts';
      if (statement.text.includes('FROM cc.application_principals p WHERE'))
        return 'person';
      if (statement.text.includes('JOIN cc.device_update_jobs u'))
        return 'receipt-actions';
      return 'unmapped';
    }),
    [
      // The route reads the plan of the job, then Execute reads its own plan row.
      'job',
      'job',
      'phrase',
      'lock',
      'page',
      'open',
      'add',
      'seal',
      'manifest',
      'confirm',
      'link',
      'counts',
      'person',
      'receipt-actions',
    ],
  );
  assert.deepEqual(
    checks,
    ['devices:read', 'devices:write', 'devices:bulk-actions'],
    'A plan of field changes rechecks no status permission.',
  );
  // The manifest is staged as one artifact of the streamed stage.
  assert.equal(artifacts.length, 1);
  const document = JSON.parse(artifacts[0].toString('utf8'));
  assert.equal(document.preview.previewId, [...previews.keys()][0]);
  assert.equal(document.preview.action, 'annotated-location');
  assert.equal(
    document.preview.manifestDigest,
    sealedDigests.values().next().value,
  );
  assert.equal(document.preview.eligible, 1);
  assert.equal(document.targets.length, 1);
  assert.equal(document.targets[0].device_id, 'dev-a');
  assert.deepEqual(document.targets[0].fields, [
    {
      field: 'notes',
      requestedValue: 'Note dev-a',
      observedValue: null,
      baselineValue: null,
      disposition: 'eligible',
    },
  ]);
  assert.equal(document.requester, actor);
  assert.equal(document.confirmer, actor);
});

test('the streamed manifest holds the bytes of the built document', async () => {
  reset();
  const answer = await execute();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const preview = [...previews.values()][0];
  const [head, ...rest] = artifacts;
  assert.equal(rest.length, 0);
  const document = {
    preview: {
      previewId: preview.preview_id,
      displayId: preview.display_id,
      customerId: customer,
      createdBy: actor,
      permissionVersion: 7,
      generation: 3,
      action: 'annotated-location',
      deprovisionReason: null,
      changes: [],
      selected: 1,
      eligible: 1,
      unchanged: 0,
      excluded: 0,
      conflicts: 0,
      fieldChanges: 1,
      oldestObservedAt: null,
      preparedAt: preview.prepared_at,
      expiresAt: preview.expires_at,
      manifestDigest: sealedDigests.get(preview.preview_id),
    },
    targets: [
      {
        ordinal: 0,
        device_id: 'dev-a',
        serial_number: 'SN-dev-a',
        org_unit_path: '/School A',
        observed_at: preview.targets[0].observed_at,
        disposition: 'eligible',
        exclusion_reason: null,
        fields: [
          {
            field: 'notes',
            requestedValue: 'Note dev-a',
            observedValue: null,
            baselineValue: null,
            disposition: 'eligible',
          },
        ],
      },
    ],
    requester: actor,
    confirmer: actor,
  };
  assert.equal(
    head.toString('utf8'),
    `${JSON.stringify(document)}\n`,
    'The stream carries the built document and one trailing newline.',
  );
});

test('one conflict device never reaches a job, and the split lands first', async () => {
  reset();
  changes = [
    fieldChange(0, 'dev-a'),
    fieldChange(1, 'dev-b'),
    fieldChange(2, 'dev-c', { current_value: 'Note dev-c' }),
  ];
  devices = new Map([
    ['dev-a', deviceRow('dev-a')],
    // The value changed after validation: not the baseline and not the request.
    ['dev-b', deviceRow('dev-b', { notes: 'Someone else' })],
    // The value already matches the request, so the change needs nothing.
    ['dev-c', deviceRow('dev-c', { notes: 'Note dev-c' })],
  ]);
  const answer = await execute();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(
    answer.body.conflicts,
    1,
    'One change reads changed-after-validation.',
  );
  assert.equal(answer.body.excluded, 0);
  const conflict = changes.find((row) => row.device_id === 'dev-b');
  assert.equal(conflict.not_run_reason, 'changed-after-validation');
  assert.equal(conflict.linked_job_id, null);
  const unchanged = changes.find((row) => row.device_id === 'dev-c');
  assert.equal(unchanged.not_run_reason, 'no-change-needed');
  assert.equal(unchanged.linked_job_id, null);
  // The preview holds the one eligible device, and no conflict device reaches a job.
  const targets = [...previews.values()].flatMap((preview) => preview.targets);
  assert.deepEqual(ids(targets.map((target) => target.device_id)), ['dev-a']);
  assert.deepEqual(ids(createdJobs.map((job) => job.displayId)), ['UPD-001']);
  assert.equal(createdJobs[0].deviceCount, 1);
  const marked = statementsOf('cc.mark_device_import_changes');
  assert.equal(marked.length, 1, 'One page marks once.');
  assert.deepEqual(
    jsonb(marked[0].values[5]),
    ['dev-b'],
    'The mark names the conflict device.',
  );
  assert.deepEqual(
    jsonb(marked[0].values[6]),
    [{ ordinal: 2, reason: 'no-change-needed' }],
    'The mark names the reason of each change that does not run.',
  );
});

test('a removed device and an ineligible status change never reach a job', async () => {
  reset();
  changes = [
    fieldChange(0, 'dev-a'),
    fieldChange(1, 'dev-b'),
    statusChange(2, 'dev-b', 'disable'),
    statusChange(3, 'dev-c', 'disable'),
  ];
  devices = new Map([
    ['dev-a', deviceRow('dev-a')],
    ['dev-b', deviceRow('dev-b', { removed_at: at(-HOUR).toISOString() })],
    ['dev-c', deviceRow('dev-c', { status: 'DISABLED' })],
  ]);
  const answer = await execute();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(
    answer.body.excluded,
    1,
    'The answer counts the status exclusion, and a removal is not one.',
  );
  const removed = changes.filter((row) => row.device_id === 'dev-b');
  for (const row of removed)
    assert.equal(
      row.not_run_reason,
      'removed',
      'A removed device does not run.',
    );
  const ineligible = changes.find((row) => row.device_id === 'dev-c');
  assert.equal(ineligible.not_run_reason, 'device-disabled');
  assert.equal(ineligible.linked_job_id, null);
  assert.equal(answer.body.receipts.length, 1, 'Only the edit job exists.');
  assert.deepEqual(
    ids(
      [...previews.values()].flatMap((preview) =>
        preview.targets.map((target) => target.device_id),
      ),
    ),
    ['dev-a'],
  );
});

test('a plan of 260 devices fills its preview in pages of 250 and keeps the built digest', async () => {
  reset();
  const names = Array.from(
    { length: 260 },
    (_, index) => `dev-${String(index).padStart(3, '0')}`,
  );
  changes = names.map((deviceId, index) => fieldChange(index, deviceId));
  devices = new Map(names.map((deviceId) => [deviceId, deviceRow(deviceId)]));
  const answer = await execute();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const pages = addedPages.map((page) => page.page.length);
  assert.deepEqual(pages, [250, 10], 'Each add call carries one page.');
  const editPages = statementsOf('FROM page p');
  assert.equal(editPages.length, 2, 'The plan read takes one page at a time.');
  for (const read of editPages) assert.equal(read.values[2], 250);
  // The digest of the pages equals the digest of the built edit list, built in one call.
  const built = editPreviewTargets(
    names.map((deviceId) => deviceRow(deviceId)),
    names.map((deviceId) => ({
      deviceId,
      field: 'notes',
      mode: 'replace',
      value: `Note ${deviceId}`,
      baselineValue: null,
    })),
  );
  assert.equal(
    sealedDigests.get([...previews.keys()][0]),
    manifestDigest(built),
    'The paged digest equals the built one.',
  );
  // The manifest streams 250 targets per read, and the document holds every target.
  const reads = statementsOf('cc.read_device_update_preview_manifest_page');
  assert.equal(reads.length, 2, 'One full page and the short closing read.');
  assert.deepEqual(
    reads.map((read) => read.values[4]),
    [null, 249],
    'Each read names the ordinal after the page before it.',
  );
  const document = JSON.parse(artifacts[0].toString('utf8'));
  assert.equal(document.targets.length, 260);
  assert.deepEqual(
    ids(document.targets.map((target) => target.device_id)),
    names,
    'The manifest keeps the device ID order of the plan read.',
  );
});

test('a Deprovision plan needs the typed phrase, trimmed and compared exactly', async () => {
  reset();
  changes = [fieldChange(0, 'dev-a'), statusChange(1, 'dev-a', 'deprovision')];
  const wrong = await execute();
  assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
  assert.deepEqual(wrong.body, { reason: 'phrase-mismatch' });
  assert.equal(
    statementsOf('cc.lock_device_import_plan').length,
    0,
    'The phrase comes first.',
  );
  assert.equal(createdJobs.length, 0);

  const partial = await execute({ typedPhrase: 'DEPROVISIO' });
  assert.equal(partial.status, 422, JSON.stringify(partial.body));

  const trimmed = await execute({ typedPhrase: '  DEPROVISION  ' });
  assert.equal(trimmed.status, 200, JSON.stringify(trimmed.body));
  assert.deepEqual(
    trimmed.body.receipts.map((receipt) => receipt.action),
    ['update-device-annotations', 'deprovision-devices'],
    'The update job runs first, then the Deprovision job.',
  );
  assert.equal(confirmations.length, 2);
  assert.equal(confirmations[1].phrase, 'DEPROVISION');
  assert.equal(
    [...previews.values()].find((preview) => preview.action === 'deprovision')
      .deprovision_reason,
    'DEPROVISION_REASON_RETIRING_DEVICE',
  );
});

test('a plan without a Deprovision ignores a typed phrase', async () => {
  reset();
  const answer = await execute({ typedPhrase: 'DEPROVISION' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(
    confirmations[0].phrase,
    null,
    'Another action sends no phrase.',
  );
});

test('a status plan fills one preview per action and reason, and every job waits', async () => {
  reset();
  changes = [
    fieldChange(0, 'dev-a'),
    statusChange(1, 'dev-a', 'disable'),
    statusChange(2, 'dev-b', 'deprovision'),
    statusChange(3, 'dev-c', 'deprovision', {
      deprovision_reason: 'DEPROVISION_REASON_UPGRADE_TRANSFER',
    }),
  ];
  devices = new Map([
    ['dev-a', deviceRow('dev-a')],
    ['dev-b', deviceRow('dev-b')],
    ['dev-c', deviceRow('dev-c')],
  ]);
  const answer = await execute({ typedPhrase: 'DEPROVISION' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(
    answer.body.receipts.map((receipt) => receipt.action),
    [
      'update-device-annotations',
      'disable-devices',
      'deprovision-devices',
      'deprovision-devices',
    ],
    'One Deprovision job runs per reason.',
  );
  assert.deepEqual(
    [...previews.values()].map((preview) => [
      preview.action,
      preview.deprovision_reason,
    ]),
    [
      ['annotated-location', null],
      ['disable', null],
      ['deprovision', 'DEPROVISION_REASON_RETIRING_DEVICE'],
      ['deprovision', 'DEPROVISION_REASON_UPGRADE_TRANSFER'],
    ],
  );
  const link = statementsOf('cc.link_device_import_jobs')[0];
  assert.deepEqual(
    link.values[5],
    [...previews.keys()],
    'The link takes every preview once, in run order.',
  );
  assert.equal(
    link.values[5].length,
    4,
    'The plan links four previews of the seven that it may hold.',
  );
  // The status digest of each preview covers its action, its reason, and its eligible devices.
  const disable = [...previews.values()].find(
    (preview) => preview.action === 'disable',
  );
  assert.equal(
    sealedDigests.get(disable.preview_id),
    actionManifestDigest(
      'disable',
      actionTargets([deviceRow('dev-a')], 'disable'),
    ),
    'The status digest equals the built one.',
  );
});

test('an executed plan answers 200 with its stored receipts and creates no job', async () => {
  reset();
  const job = {
    jobId: '77777777-7777-4777-8777-777777777777',
    displayId: 'UPD-004',
    action: 'annotated-location',
    deviceCount: 2,
    customerId: customer,
  };
  createdJobs = [job];
  changes = [
    fieldChange(0, 'dev-a', {
      linked_job_id: job.jobId,
      operation_number: 1,
    }),
    fieldChange(1, 'dev-b', {
      not_run_reason: 'changed-after-validation',
    }),
  ];
  lockResult = {
    outcome: 'executed',
    plan: sqlPlan({ revision: 2, state: 'executed', changedBy: actor }),
    receipts: [storedReceipt(job)],
  };
  const answer = await execute();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body.receipts, [
    {
      jobId: job.jobId,
      displayId: 'UPD-004',
      action: 'update-device-annotations',
      status: 'accepted',
      deviceCount: 2,
    },
  ]);
  assert.equal(answer.body.plan.state, 'executed');
  assert.equal(answer.body.conflicts, 1);
  assert.equal(createdJobs.length, 1, 'A repeat creates no second job.');
  assert.equal(statementsOf('cc.add_device_update_preview_targets').length, 0);
  assert.equal(statementsOf('cc.confirm_device_update_preview').length, 0);
  assert.equal(statementsOf('cc.link_device_import_jobs').length, 0);
  assert.deepEqual(admissions, [], 'A repeat admits nothing new.');
});

test('another plan revision answers 409 and an expired plan answers 410', async () => {
  reset();
  lockResult = { outcome: 'conflict', plan: sqlPlan({ revision: 3 }) };
  const conflict = await execute();
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.reason, 'plan-conflict');
  assert.equal(conflict.body.plan.revision, 3);
  assert.equal(conflict.body.plan.changedBy, null);
  assert.equal(createdJobs.length, 0);

  reset();
  const expiresAt = at(-1).toISOString();
  lockResult = { outcome: 'expired', plan: sqlPlan({ expiresAt }), expiresAt };
  const expired = await execute();
  assert.equal(expired.status, 410, JSON.stringify(expired.body));
  assert.equal(expired.body.reason, 'plan-expired');
  assert.equal(expired.body.plan.state, 'expired');
  assert.equal(expired.body.plan.expiresAt, expiresAt);
  assert.equal(createdJobs.length, 0);
});

test('a cancelled plan answers 409 and no plan answers the same conflict', async () => {
  reset();
  lockResult = {
    outcome: 'conflict',
    plan: sqlPlan({ revision: 4, state: 'cancelled' }),
  };
  const answer = await execute();
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.equal(answer.body.reason, 'plan-conflict');
  assert.equal(answer.body.plan.state, 'cancelled');
});

test('a plan with no change left answers 409 nothing-to-run and stays open', async () => {
  reset();
  changes = [fieldChange(0, 'dev-a')];
  devices = new Map([
    ['dev-a', deviceRow('dev-a', { removed_at: at(-HOUR).toISOString() })],
  ]);
  const answer = await execute();
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, { reason: 'nothing-to-run' });
  assert.equal(planState, 'open', 'The plan stays open.');
  assert.deepEqual(transactions, ['rollback']);
  assert.equal(createdJobs.length, 0);
  assert.equal(statementsOf('cc.link_device_import_jobs').length, 0);
  assert.equal(admissions.length, 0);
  assert.equal(
    changes[0].not_run_reason,
    null,
    'A refused Execute stores no reason.',
  );
});

test('a refused link rolls back every job of the plan', async () => {
  reset();
  changes = [fieldChange(0, 'dev-a'), statusChange(1, 'dev-a', 'disable')];
  linkRefuses = true;
  const answer = await execute();
  assert.equal(answer.status, 503, 'A refused link answers no success.');
  assert.deepEqual(transactions, ['rollback'], 'One transaction rolls back.');
  assert.equal(createdJobs.length, 0, 'No job survives the refusal.');
  assert.equal(planState, 'open');
  assert.equal(changes[0].linked_job_id, null);
  assert.equal(admissions.length, 0);
});

test('the route rechecks each status permission that the plan recorded', async () => {
  reset({ recordedStatuses: ['disable', 'deprovision'] });
  allowed = new Set([
    'devices:read',
    'devices:write',
    'devices:bulk-actions',
    'devices:status',
  ]);
  const answer = await execute({ typedPhrase: 'DEPROVISION' });
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, [
    'devices:read',
    'devices:write',
    'devices:bulk-actions',
    'devices:status',
    'devices:deprovision',
  ]);
  assert.equal(
    statementsOf('cc.lock_device_import_plan').length,
    0,
    'A refusal never locks.',
  );
  assert.equal(createdJobs.length, 0);
});

test('the route asks for the three import actions before it reads the plan', async () => {
  reset({ actions: ['devices:read', 'devices:bulk-actions'] });
  const answer = await execute();
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.deepEqual(checks, ['devices:read', 'devices:write']);
  assert.equal(statements.length, 0);
});

test('another customer reads 404 and Execute accepts the requester only', async () => {
  reset();
  devices = new Map();
  const foreign = await post('/api/devices/imports/EXP-001/execute', {
    planId,
    planRevision: 1,
    typedPhrase: null,
  });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));

  jobVisible = false;
  const invisible = await execute();
  assert.equal(invisible.status, 404, JSON.stringify(invisible.body));
  assert.deepEqual(invisible.body, { reason: 'job-not-found' });
  assert.equal(createdJobs.length, 0);

  // The lock answers not-found for a job that another person requested.
  reset();
  lockResult = { outcome: 'not-found' };
  const other = await execute();
  assert.equal(other.status, 404, JSON.stringify(other.body));
});

test('an invalid execute body answers 400 before any person check', async () => {
  reset();
  for (const body of [
    { planId: 'not-a-uuid', planRevision: 1, typedPhrase: null },
    { planId, planRevision: 0, typedPhrase: null },
    { planId, planRevision: 1 },
    { planId, planRevision: 1, typedPhrase: null, extra: true },
  ]) {
    const answer = await post(executePath, body);
    assert.equal(
      answer.status,
      400,
      `${JSON.stringify(body)}: ${JSON.stringify(answer.body)}`,
    );
  }
  assert.deepEqual(checks, []);
  assert.equal(statements.length, 0);
});

test('no call of Execute passes more than one page', async () => {
  reset();
  const names = Array.from(
    { length: 600 },
    (_, index) => `dev-${String(index).padStart(3, '0')}`,
  );
  changes = names.map((deviceId, index) => fieldChange(index, deviceId));
  devices = new Map(names.map((deviceId) => [deviceId, deviceRow(deviceId)]));
  const answer = await execute();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  for (const page of addedPages)
    assert.ok(
      page.page.length <= 250,
      `An add call carries ${page.page.length} targets.`,
    );
  for (const statement of statementsOf('cc.mark_device_import_changes')) {
    assert.ok(
      statement.values[5].length <= 250,
      'A mark call names 250 devices.',
    );
    assert.ok(
      statement.values[6].length <= 250,
      'A mark call names 250 reasons.',
    );
  }
  const reads = statementsOf('cc.read_device_update_preview_manifest_page');
  assert.ok(reads.length >= 3, 'The manifest arrives in pages.');
  const link = statementsOf('cc.link_device_import_jobs')[0];
  assert.ok(
    link.values[5].length <= 7,
    'A link call names seven previews at most.',
  );
  const document = JSON.parse(artifacts[0].toString('utf8'));
  assert.equal(document.targets.length, 600);
});
