import { Component, computed, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-stale-badge',
  imports: [DatePipe, MatButtonModule, MatTooltipModule],
  templateUrl: './stale-badge.html',
  styleUrl: './stale-badge.css',
})
export class StaleBadge {
  readonly observedAt = input.required<string>();
  readonly staleAfterSeconds = input(300);
  readonly forceStale = input(false);
  readonly refreshing = input(false);
  readonly refresh = output<void>();
  protected readonly ageSeconds = computed(() =>
    Math.max(
      0,
      Math.round((Date.now() - new Date(this.observedAt()).getTime()) / 1000),
    ),
  );
  protected readonly stale = computed(
    () => this.forceStale() || this.ageSeconds() > this.staleAfterSeconds(),
  );
  protected readonly relative = computed(() => {
    const seconds = this.ageSeconds();
    if (seconds < 60)
      return `${seconds} ${seconds === 1 ? 'second' : 'seconds'} ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
      return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    const days = Math.round(hours / 24);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  });
}
