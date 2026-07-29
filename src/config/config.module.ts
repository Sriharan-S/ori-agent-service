import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfiguration, validateConfig } from './configuration';

/**
 * Provides the typed configuration to every module.
 *
 * Global, and separate from AppModule, because the database and LLM modules are
 * themselves global — a provider declared in AppModule is not visible to them.
 *
 * `validateConfig` runs in the factory. It now covers only the case where
 * running is worse than stopping — a security guarantee switched off in
 * production. Missing or wrong variables are reported by `inspectConfiguration`
 * to the setup screen instead, because a process that exits cannot tell anyone
 * which variable it wanted.
 */
@Global()
@Module({
  providers: [
    {
      provide: CONFIG,
      useFactory: () => {
        const config = loadConfiguration();
        validateConfig(config);
        return config;
      },
    },
  ],
  exports: [CONFIG],
})
export class OriConfigModule {}
