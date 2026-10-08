import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  actionSchema,
  actionScopeKinds,
  grantsForPreset,
  type Action,
  type Grant,
  type ResourceScope,
} from '@campus/application-contracts';
import { AuthStore } from '../auth.store';
import { CustomerStore } from '../customer-settings/customer.store';
import { SchoolsStore } from '../schools/schools.store';
import { actionLabels } from '../action-labels';

export function sameResource(left: ResourceScope, right: ResourceScope) {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'platform' || right.kind === 'platform') return true;
  return (
    left.customerId === right.customerId &&
    (left.kind !== 'school' ||
      (right.kind === 'school' && left.schoolId === right.schoolId))
  );
}

@Component({
  selector: 'app-scoped-grants',
  imports: [DatePipe, MatButtonModule, MatCheckboxModule],
  providers: [SchoolsStore],
  templateUrl: './scoped-grants.html',
  styleUrl: './platform-access.css',
})
export class ScopedGrants {
  readonly value = input.required<Grant[]>();
  readonly disabled = input(false);
  readonly capacity = input(256);
  readonly changed = output<Grant[]>();
  readonly auth = inject(AuthStore);
  readonly customer = inject(CustomerStore);
  readonly schools = inject(SchoolsStore);
  readonly selected = signal<ResourceScope | null>(null);
  readonly error = signal('');
  readonly message = signal('');
  readonly loaded = signal(false);
  readonly labels = actionLabels;
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  readonly selectedActions = computed(() =>
    actionSchema.options.filter((action) => {
      const scope = this.selected();
      return scope && actionScopeKinds[action].includes(scope.kind);
    }),
  );
  readonly currentSchool = computed(() => {
    const scope = this.selected();
    const school = this.schools.detail();
    return scope?.kind === 'school' &&
      school?.id === scope.schoolId &&
      school.customerId === scope.customerId
      ? school
      : null;
  });
  readonly canAdd = computed(() => {
    const scope = this.selected();
    if (!scope || this.disabled() || this.auth.interrupted()) return false;
    if (scope.kind === 'district')
      return (
        this.customer.customer()?.customerId === scope.customerId &&
        !this.customer.stale() &&
        !this.customer.loading()
      );
    if (scope.kind === 'school')
      return (
        !!this.currentSchool()?.effectiveIds &&
        !this.schools.errors().detail &&
        !this.schools.loading().detail
      );
    return false;
  });
  private identity = this.schools.sessionKey();

  constructor() {
    effect(() => {
      const identity = this.schools.sessionKey();
      if (identity === this.identity) return;
      this.identity = identity;
      untracked(() => {
        this.selected.set(null);
        this.loaded.set(false);
        this.error.set('');
        this.message.set(
          'Resource access changed. Choose district or school again. Your proposed grants remain in the form.',
        );
      });
    });
  }

  async load() {
    if (this.disabled()) return;
    this.loaded.set(true);
    await Promise.all([this.customer.refresh(), this.schools.refresh(0)]);
  }

  async choose(scope: ResourceScope) {
    if (this.disabled()) return;
    this.selected.set(scope);
    this.error.set('');
    this.message.set('');
    if (scope.kind === 'school') await this.schools.inspect(scope.schoolId);
  }

  scopeLabel(scope: ResourceScope) {
    return scope.kind === 'school'
      ? `School ${scope.schoolId} in ${scope.customerId}`
      : scope.kind === 'district'
        ? `District ${scope.customerId}`
        : 'Installation';
  }

  has(action: Action) {
    const scope = this.selected();
    return (
      !!scope &&
      this.value().some(
        (grant) => grant.action === action && sameResource(grant.scope, scope),
      )
    );
  }

  canRemove(grant: Grant) {
    return (
      !this.disabled() &&
      !this.auth.interrupted() &&
      this.auth.can(grant.action, grant.scope)
    );
  }

  remove(grant: Grant, restoreFocus = true) {
    if (!this.canRemove(grant)) return;
    this.changed.emit(
      this.value().filter(
        (item) =>
          item.action !== grant.action ||
          !sameResource(item.scope, grant.scope),
      ),
    );
    this.message.set(
      'Permission removed from your edits. Review and confirm to save this change.',
    );
    if (restoreFocus) {
      const identity = this.schools.sessionKey();
      afterNextRender(
        () => {
          if (identity === this.schools.sessionKey())
            this.element.nativeElement
              .querySelector<HTMLElement>('#scoped-grants-title')
              ?.focus();
        },
        { injector: this.injector },
      );
    }
  }

  toggle(action: Action, checked: boolean) {
    const scope = this.selected();
    if (!scope || this.disabled() || !this.auth.can(action, scope)) return;
    if (!checked) {
      this.remove({ action, scope }, false);
      return;
    }
    if (!this.canAdd() || this.has(action)) return;
    this.publish([...this.value(), { action, scope }]);
  }

  presetAllowed(administrator: boolean) {
    const scope = this.selected();
    return (
      !!scope &&
      this.canAdd() &&
      [
        ...this.presetGrants(administrator, scope),
        ...this.value().filter((grant) => sameResource(grant.scope, scope)),
      ].every((grant) => this.auth.can(grant.action, scope))
    );
  }

  preset(administrator: boolean) {
    const scope = this.selected();
    if (!scope || !this.presetAllowed(administrator)) return;
    const retained = this.value().filter(
      (grant) => !sameResource(grant.scope, scope),
    );
    this.publish([...retained, ...this.presetGrants(administrator, scope)]);
  }

  private presetGrants(administrator: boolean, scope: ResourceScope) {
    if (scope.kind === 'platform') return [];
    return grantsForPreset(
      administrator
        ? scope.kind === 'school'
          ? 'school-administrator'
          : 'district-administrator'
        : 'viewer',
      scope,
    );
  }

  private publish(grants: Grant[]) {
    if (grants.length > this.capacity()) {
      this.error.set(
        'You have reached the limit of 256 permissions. Remove one before adding another.',
      );
      return;
    }
    this.error.set('');
    this.changed.emit(grants);
    this.message.set(
      'Permissions updated in the form. Review and confirm to save your changes.',
    );
  }
}
