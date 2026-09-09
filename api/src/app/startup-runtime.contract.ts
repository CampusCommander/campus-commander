export interface StartupStatus {
  phase: 1;
  status: 'ready' | 'not-ready';
  checks: Array<{ name: string; status: 'ready' | 'not-ready' }>;
}

export interface StartupRuntime {
  verify(credential: string | undefined): Promise<boolean>;
  getStatus(): Promise<StartupStatus>;
  close(): Promise<void>;
}

export interface StartupRuntimeModule {
  createStartupRuntime(configPath: string): Promise<StartupRuntime>;
}
