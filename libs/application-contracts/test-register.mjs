import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@campus/application-contracts') {
      return nextResolve(
        new URL('./src/index.ts', import.meta.url).href,
        context,
      );
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        context.parentURL?.includes('/libs/')
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
