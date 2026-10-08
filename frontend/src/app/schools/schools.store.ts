import {
  Injectable,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { z } from 'zod';
import {
  SCHOOL_REFERENCE_MAX_AGE_MS,
  schoolDefinitionSchema,
  schoolDefinitionPageSchema,
  schoolAuditPageSchema,
  schoolReferenceStateSchema,
  type SchoolDefinition,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';

type References = z.infer<typeof schoolReferenceStateSchema>;
type Audit = z.infer<typeof schoolAuditPageSchema>;
type Page = z.infer<typeof schoolDefinitionPageSchema>;
type Region = 'list' | 'detail' | 'audit' | 'references';

export function schoolsReadable(auth: InstanceType<typeof AuthStore>) {
  return (
    auth.metadata()?.phase === 3 &&
    !!auth
      .session()
      ?.identity.grants.some((grant) => grant.action === 'schools:read')
  );
}

@Injectable()
export class SchoolsStore implements OnDestroy {
  readonly auth = inject(AuthStore);
  readonly page = signal<Page | null>(null);
  readonly detail = signal<SchoolDefinition | null>(null);
  readonly audit = signal<Audit | null>(null);
  readonly references = signal<References | null>(null);
  readonly loading = signal<Record<Region, boolean>>({
    list: false,
    detail: false,
    audit: false,
    references: false,
  });
  readonly errors = signal<Record<Region, string>>({
    list: '',
    detail: '',
    audit: '',
    references: '',
  });
  readonly observedAt = signal<Record<Region, string | null>>({
    list: null,
    detail: null,
    audit: null,
    references: null,
  });
  readonly now = signal(Date.now());
  readonly readable = computed(
    () => schoolsReadable(this.auth) && !this.auth.interrupted(),
  );
  readonly manager = computed(
    () =>
      !this.auth.interrupted() &&
      this.auth.metadata()?.phase === 3 &&
      !!this.auth
        .session()
        ?.identity.grants.some(
          (grant) =>
            grant.action === 'schools:manage' &&
            (grant.scope.kind === 'platform' ||
              grant.scope.kind === 'district'),
        ),
  );
  readonly fresh = computed(() => {
    const state = this.references();
    const observation = state?.observation;
    const age = observation
      ? this.now() - Date.parse(observation.observedAt)
      : Infinity;
    return (
      this.manager() &&
      !this.errors().references &&
      !this.loading().references &&
      !!state?.fresh &&
      !state.checking &&
      !!observation &&
      observation.customerId === state.customerId &&
      observation.generation === state.generation &&
      age >= 0 &&
      age < SCHOOL_REFERENCE_MAX_AGE_MS
    );
  });
  private readonly timer = setInterval(() => this.now.set(Date.now()), 1000);
  private readonly requests: Record<Region, number> = {
    list: 0,
    detail: 0,
    audit: 0,
    references: 0,
  };
  private destroyed = false;
  private identity = this.sessionKey();

  constructor() {
    effect(() => {
      const identity = this.sessionKey();
      if (identity === this.identity) return;
      this.identity = identity;
      untracked(() => {
        for (const region of Object.keys(this.requests) as Region[])
          this.requests[region] += 1;
        this.page.set(null);
        this.detail.set(null);
        this.audit.set(null);
        this.references.set(null);
        this.loading.set({
          list: false,
          detail: false,
          audit: false,
          references: false,
        });
        this.errors.set({ list: '', detail: '', audit: '', references: '' });
        this.observedAt.set({
          list: null,
          detail: null,
          audit: null,
          references: null,
        });
      });
    });
  }

  ngOnDestroy() {
    this.destroyed = true;
    clearInterval(this.timer);
  }

  sessionKey() {
    const session = this.auth.session();
    return session && !this.auth.interrupted()
      ? `${session.identity.id}:${session.identity.permissionVersion}:${session.csrfToken}`
      : '';
  }

  private async read<T>(
    region: Region,
    path: string,
    schema: z.ZodType<T>,
    accept: (value: T) => void,
    body?: unknown,
  ) {
    const key = this.sessionKey();
    if (!key || (body !== undefined && this.loading()[region])) return;
    const request = ++this.requests[region];
    const current = () =>
      !this.destroyed &&
      key === this.sessionKey() &&
      request === this.requests[region];
    this.loading.update((value) => ({ ...value, [region]: true }));
    this.errors.update((value) => ({ ...value, [region]: '' }));
    try {
      const response = await this.auth.request(path, body);
      if (!response.ok) throw new Error();
      const value = schema.parse(await response.json());
      if (!current()) return;
      accept(value);
      this.observedAt.update((value) => ({
        ...value,
        [region]: new Date().toISOString(),
      }));
    } catch {
      if (current())
        this.errors.update((value) => ({
          ...value,
          [region]:
            region === 'references'
              ? 'Google organizational units are unavailable. Check your connection, then refresh Google units. Your draft is still here.'
              : 'Saved school data is unavailable or outside your access. Check your connection and access, then retry.',
        }));
    } finally {
      if (current())
        this.loading.update((value) => ({ ...value, [region]: false }));
    }
  }

  refresh(offset = this.page()?.offset ?? 0) {
    if (!this.readable()) return Promise.resolve();
    return this.read(
      'list',
      `/api/schools?offset=${offset}&limit=20`,
      schoolDefinitionPageSchema,
      (page) => this.page.set(page),
    );
  }

  inspect(id: string) {
    if (!this.readable()) return Promise.resolve();
    if (this.detail()?.id !== id) {
      this.detail.set(null);
      this.audit.set(null);
    }
    return this.read(
      'detail',
      `/api/schools/${id}`,
      schoolDefinitionSchema,
      (value) => {
        if (value.id !== id) throw new Error();
        this.detail.set(value);
      },
    );
  }

  readAudit(offset = 0) {
    const school = this.detail();
    if (
      !school ||
      !this.auth.can('security-events:read', {
        kind: 'school',
        customerId: school.customerId,
        schoolId: school.id,
      })
    )
      return Promise.resolve();
    return this.read(
      'audit',
      `/api/schools/${school.id}/audit?offset=${offset}`,
      schoolAuditPageSchema,
      (value) => {
        if (this.detail()?.id === school.id) this.audit.set(value);
      },
    );
  }

  readReferences(refresh = false) {
    if (!this.manager()) return Promise.resolve();
    const state = this.references();
    if (
      refresh &&
      (!state ||
        state.checking ||
        (state.retryAt && Date.parse(state.retryAt) > this.now()))
    )
      return Promise.resolve();
    return this.read(
      'references',
      `/api/schools/references${refresh ? '/refresh' : ''}`,
      z.object({ references: schoolReferenceStateSchema.nullable() }),
      (value) => this.references.set(value.references),
      refresh && state
        ? { customerId: state.customerId, generation: state.generation }
        : undefined,
    );
  }
}
