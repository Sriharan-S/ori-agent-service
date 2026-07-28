import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AdminModule } from './admin/admin.module';
import { HealthController } from './api/health.controller';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import {
  MIDDLEWARE_ROUTE_PATTERN,
  RequestIdMiddleware,
} from './common/request-id.middleware';
import { CONFIG, loadConfiguration, validateConfig } from './config/configuration';
import { DbModule } from './db/db.module';
import { LlmModule } from './llm/llm.module';
import { ManagementModule } from './management/management.module';
import { MemoryModule } from './memory/memory.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { RegistryModule } from './registry/registry.module';
import { MaintenanceService } from './common/maintenance.service';

const config = loadConfiguration();

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.service.logLevel,
        genReqId: (req, res) => {
          const existing = req.headers['x-request-id'];
          const id =
            typeof existing === 'string' && /^[\w-]{8,64}$/.test(existing)
              ? existing
              : randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        // Credentials and message bodies must never reach a log line.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers["x-api-key"]',
            'req.headers["x-end-user-token"]',
            'req.headers["x-end-user"]',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            'req.body.message',
            'req.body.password',
          ],
          remove: true,
        },
        transport: config.service.isProduction
          ? undefined
          : { target: 'pino-pretty', options: { singleLine: true } },
      },
    }),
    DbModule,
    AuthModule,
    LlmModule,
    AuditModule,
    MemoryModule,
    RegistryModule,
    OrchestratorModule,
    ManagementModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: CONFIG,
      useFactory: () => {
        validateConfig(config);
        return config;
      },
    },
    MaintenanceService,
  ],
  exports: [CONFIG],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes(MIDDLEWARE_ROUTE_PATTERN);
  }
}
