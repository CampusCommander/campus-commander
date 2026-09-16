import { Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-skeleton',
  templateUrl: './skeleton.html',
  styleUrl: './skeleton.css',
})
export class Skeleton {
  readonly rows = input(3);
  readonly variant = input<'rows' | 'lines'>('rows');
  readonly avatar = input(false);
  protected readonly blocks = computed(() =>
    Array.from({ length: Math.max(0, this.rows()) }, (_, index) => index),
  );
}
