import { Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { AuthStore } from '../auth.store';
import { DiagnosticsStore } from './diagnostics.store';

@Component({
  selector: 'app-diagnostics',
  imports: [MatButtonModule, DatePipe],
  templateUrl: './diagnostics.html',
  styleUrl: './diagnostics.css',
})
export class Diagnostics {
  protected readonly auth = inject(AuthStore);
  protected readonly diagnostics = inject(DiagnosticsStore);
  protected readonly operations = [
    {
      id: 'postgresql',
      label: 'PostgreSQL',
      description: 'Verify a synthetic database transaction and its rollback.',
    },
    {
      id: 'redis',
      label: 'Redis',
      description: 'Write, read, and remove a temporary cache value.',
    },
    {
      id: 'kestra',
      label: 'Kestra',
      description: 'Run a fixed task and verify the worker result.',
    },
    {
      id: 'artifacts',
      label: 'Artifact storage',
      description: 'Publish, read, verify, and remove a synthetic artifact.',
    },
  ] as const;
}
