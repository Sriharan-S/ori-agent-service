import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { AdminAuthService } from '../admin/admin-auth.service';
import { ObservabilityService } from '../admin/observability.service';
import { CONFIG, type AppConfig } from '../config/configuration';

const INTERVAL_MS = 5 * 60 * 1000;

/**
 * Periodic housekeeping.
 *
 * Two jobs, both of which exist because a number nobody trusts is worse than no
 * number: expired sessions accumulate, and runs whose client disconnected
 * mid-stream stay `running` forever and quietly inflate the active count.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MaintenanceService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly sessions: AdminAuthService,
    private readonly observability: ObservabilityService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), INTERVAL_MS);
    // Do not hold the process open for a housekeeping timer.
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(): Promise<void> {
    try {
      await this.sessions.pruneSessions();

      const reaped = await this.observability.reapStaleRuns(
        this.config.behaviour.runTimeoutMs,
      );
      if (reaped > 0) {
        this.logger.warn(`Marked ${reaped} abandoned run(s) as failed`);
      }
    } catch (error) {
      this.logger.warn(
        `Maintenance sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
