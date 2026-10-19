export interface ArtifactWriter {
  stage(...args: unknown[]): Promise<unknown>;
  publish(...args: unknown[]): Promise<unknown>;
}

export async function storeJsonDocument(..._args: unknown[]): Promise<string> {
  return '';
}
