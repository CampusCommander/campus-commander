import { Component, inject, OnInit } from '@angular/core';
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
  protected readonly callbackFailed =
    inject(ActivatedRoute).snapshot.queryParamMap.has('error');
  private readonly title = inject(Title);
  ngOnInit() {
    this.title.setTitle('Sign in · Campus Commander');
    void this.auth.metadataReady();
  }
}
