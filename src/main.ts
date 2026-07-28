import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CONFIG, type AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get<AppConfig>(CONFIG);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Required for the read pool's write assertion and clean pool shutdown.
  app.enableShutdownHooks();

  await app.listen(config.service.port);

  new Logger('Bootstrap').log(
    `Ori agent service listening on :${config.service.port} (${config.service.nodeEnv})`,
  );
}

void bootstrap().catch((error: unknown) => {
  // A failed boot is usually the read-replica write assertion or missing
  // configuration. Both must stop the process rather than run degraded.
   
  console.error(
    'Failed to start Ori agent service:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
