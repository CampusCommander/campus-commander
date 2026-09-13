import {
  afterNextRender,
  Component,
  inject,
  Injector,
  OnInit,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { Title } from '@angular/platform-browser';
import { AuthStore } from '../auth.store';

@Component({
  selector: 'app-login',
  imports: [MatButtonModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login implements OnInit {
  protected readonly auth = inject(AuthStore);
  protected readonly signingIn = signal(false);
  protected readonly callbackFailed =
    inject(ActivatedRoute).snapshot.queryParamMap.has('error');
  private readonly title = inject(Title);
  private readonly injector = inject(Injector);
  ngOnInit() {
    this.title.setTitle('Sign in · Campus Commander');
    void this.auth.metadataReady();
  }
  protected startSignIn(event: MouseEvent) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    this.signingIn.set(true);
    afterNextRender(() => window.location.assign('/api/auth/login'), {
      injector: this.injector,
    });
  }
}
