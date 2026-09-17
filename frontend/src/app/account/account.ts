import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthStore } from '../auth.store';
import { ConnectionStore } from '../google-connection/connection.store';
import { CustomerStore } from '../customer-settings/customer.store';
import { schoolsReadable } from '../schools/schools.store';

@Component({
  selector: 'app-account',
  imports: [RouterLink],
  templateUrl: './account.html',
  styleUrl: './account.css',
})
export class Account {
  protected readonly auth = inject(AuthStore);
  private readonly connection = inject(ConnectionStore);
  private readonly customer = inject(CustomerStore);
  protected readonly tasks = computed(() => {
    if (this.auth.interrupted()) return [];
    const platformAccess = this.auth.can('platform-users:read', {
      kind: 'platform',
    });
    return [
      {
        visible: this.connection.readable(),
        path: '/google-connection',
        label: 'Review Google connection',
        description:
          'Connect your Google Workspace customer and check its connection status.',
      },
      {
        visible: this.customer.readable(),
        path: '/customer-settings',
        label: 'Review customer settings',
        description: 'Review your customer name and setup progress.',
      },
      {
        visible: schoolsReadable(this.auth),
        path: '/schools',
        label: 'Browse schools',
        description: 'View the schools and school scopes available to you.',
      },
      {
        visible: platformAccess,
        path: '/platform-users',
        label: 'Review platform access',
        description:
          'Review who can use Campus Commander and their assigned access.',
      },
      {
        visible: platformAccess,
        path: '/invitations',
        label: 'Review platform invitations',
        description:
          'Review invitations that give people access to Campus Commander.',
      },
    ].filter((task) => task.visible);
  });
}
