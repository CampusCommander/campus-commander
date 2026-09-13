import { Component, inject } from '@angular/core';
import { AuthStore } from '../auth.store';

@Component({
  selector: 'app-account',
  templateUrl: './account.html',
  styleUrl: './account.css',
})
export class Account {
  protected readonly auth = inject(AuthStore);
}
