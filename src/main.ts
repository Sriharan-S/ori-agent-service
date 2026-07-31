import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { CONFIG, type AppConfig } from './config/configuration';
import { setupOpenApi } from './api/openapi';
import { SetupService } from './setup/setup.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  const config = app.get<AppConfig>(CONFIG);

  // A function bundle is bigger than a chat message — ten functions with their
  // SQL and hints run to a few hundred kilobytes. The 100kb Express default
  // would reject a real export on the way back in.
  app.useBodyParser('json', { limit: '2mb' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  setupOpenApi(app, config.service.publicUrl);

  // Required for the read pool's write assertion and clean pool shutdown.
  app.enableShutdownHooks();

  await app.listen(config.service.port);

  const logger = new Logger('Bootstrap');
  logger.log(
    `Ori agent service listening on :${config.service.port} (${config.service.nodeEnv})`,
  );

  // Say where onboarding stands rather than leaving it to be discovered. A
  // half-configured deployment now serves a setup screen instead of exiting, so
  // the log has to point at it.
  const status = await app.get(SetupService).status();

  if (status.complete) {
    logger.log(`Console:  ${config.service.publicUrl}/admin`);
    logger.log(`API docs: ${config.service.publicUrl}/docs`);

    const incomplete = status.steps.filter((step) => step.state !== 'done');
    for (const step of incomplete) {
      logger.warn(`${step.title}: ${step.summary}`);
    }
  } else {
    const step = status.steps.find((entry) => entry.id === status.stage);
    logger.warn('Setup is not finished, so the service cannot serve requests yet.');
    if (step) logger.warn(`Next: ${step.title} — ${step.summary}`);
    logger.warn(`Finish setup at ${config.service.publicUrl}/admin`);
  }
}

void bootstrap().catch((error: unknown) => {
  // Missing configuration and an unreachable database are setup states now, not
  // boot failures — they are reported by the setup screen. Reaching here means
  // something genuinely unrecoverable, such as the port being taken or a
  // security guarantee explicitly disabled in production.

  console.error(
    'Failed to start Ori agent service:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
