export interface AuthorizeDeps {
  phase: number | undefined;
  audit(...args: unknown[]): Promise<void>;
}

export async function authorizeAction(..._args: unknown[]): Promise<void> {}
