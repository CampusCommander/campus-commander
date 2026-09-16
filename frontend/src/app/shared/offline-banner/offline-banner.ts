import { Component, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-offline-banner',
  imports: [DatePipe, MatButtonModule],
  templateUrl: './offline-banner.html',
  styleUrl: './offline-banner.css',
})
export class OfflineBanner {
  readonly cachedAt = input<string | null>(null);
  readonly writesDisabled = input(true);
  readonly reconnecting = input(false);
  readonly reconnect = output<void>();
}
