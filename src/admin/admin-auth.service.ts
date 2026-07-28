import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CONFIG, type AppConfig } from '../config/configuration';
import { hashPassword, newSessionToken, verifyPassword } from '../common/crypto';
import { PrimaryDb, quoteIdent } from '../db/primary.db';

export type AdminRole = 'owner' | 'admin' | 'viewer';

export interface AdminUser {
  id: number;
  email: string;
  name: string | null;
  role: AdminRole;
  isActive: boolean;
  lastLoginAt: Date | null;
}

interface AdminRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string;
  role: string;
  is_active: boolean;
  last_login_at: Date | null;
}

/**
 * Operator accounts for the dashboard.
 *
 * Local accounts rather than SSO against a host application, deliberately: the
 * dashboard is most useful when something is broken, and that is exactly when a
 * dependency on another system being up is worst. It also keeps operator access
 * independent of whichever product happens to be calling the API.
 *
 * Sessions are opaque tokens in an HttpOnly cookie, stored hashed. The token
 * itself is never written to the database, so a dump of the sessions table does
 * not let anyone log in.
 */
@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly db: PrimaryDb,
  ) {}

  private get schema(): string {
    return quoteIdent(this.db.schema);
  }

  async onModuleInit(): Promise<void> {
    await this.bootstrap();
  }

  async login(
    email: string,
    password: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ token: string; user: AdminUser; expiresAt: Date }> {
    const row = await this.db.one<AdminRow>(
      `SELECT id, email, name, password_hash, role, is_active, last_login_at
         FROM ${this.schema}.admin_users
        WHERE lower(email) = lower($1)`,
      [email],
    );

    // The same message and roughly the same work either way, so a wrong email
    // and a wrong password are not distinguishable from outside.
    const ok = row
      ? await verifyPassword(password, row.password_hash)
      : await verifyPassword(password, await hashPassword('placeholder'));

    if (!row || !ok || !row.is_active) {
      this.logger.warn(`Failed dashboard login for "${email}"`);
      throw new UnauthorizedException('Incorrect email or password');
    }

    const token = newSessionToken();
    const expiresAt = new Date(
      Date.now() + this.config.security.sessionTtlHours * 3600_000,
    );

    await this.db.query(
      `INSERT INTO ${this.schema}.admin_sessions
         (admin_user_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        row.id,
        hashToken(token),
        expiresAt,
        meta.ip ?? null,
        meta.userAgent?.slice(0, 300) ?? null,
      ],
    );

    await this.db.query(
      `UPDATE ${this.schema}.admin_users SET last_login_at = now() WHERE id = $1`,
      [row.id],
    );

    this.logger.log(`Dashboard login: ${row.email}`);
    return { token, user: toUser(row), expiresAt };
  }

  async resolveSession(token: string | undefined): Promise<AdminUser> {
    if (!token) throw new UnauthorizedException('Sign in to continue');

    const row = await this.db.one<AdminRow>(
      `SELECT u.id, u.email, u.name, u.password_hash, u.role, u.is_active, u.last_login_at
         FROM ${this.schema}.admin_sessions s
         JOIN ${this.schema}.admin_users u ON u.id = s.admin_user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active
        LIMIT 1`,
      [hashToken(token)],
    );

    if (!row) throw new UnauthorizedException('Your session has expired');
    return toUser(row);
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.query(
      `DELETE FROM ${this.schema}.admin_sessions WHERE token_hash = $1`,
      [hashToken(token)],
    );
  }

  async listUsers(): Promise<AdminUser[]> {
    const rows = await this.db.query<AdminRow>(
      `SELECT id, email, name, password_hash, role, is_active, last_login_at
         FROM ${this.schema}.admin_users ORDER BY email`,
    );
    return rows.map(toUser);
  }

  async createUser(
    email: string,
    password: string,
    name: string | null,
    role: AdminRole,
  ): Promise<AdminUser> {
    const row = await this.db.one<AdminRow>(
      `INSERT INTO ${this.schema}.admin_users (email, name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, password_hash, role, is_active, last_login_at`,
      [email.toLowerCase(), name, await hashPassword(password), role],
    );
    return toUser(row!);
  }

  async setPassword(id: number, password: string): Promise<void> {
    await this.db.query(
      `UPDATE ${this.schema}.admin_users SET password_hash = $2, updated_at = now()
        WHERE id = $1`,
      [id, await hashPassword(password)],
    );
    // Every existing session for that account stops working.
    await this.db.query(
      `DELETE FROM ${this.schema}.admin_sessions WHERE admin_user_id = $1`,
      [id],
    );
  }

  /** Expired rows are dead weight and a small privacy liability. */
  async pruneSessions(): Promise<void> {
    await this.db
      .query(`DELETE FROM ${this.schema}.admin_sessions WHERE expires_at < now()`)
      .catch(() => undefined);
  }

  /**
   * Creates the first operator account from the environment, once.
   *
   * Only runs when the table is empty, so the bootstrap variables cannot be
   * used to reset an account later — change a password through the dashboard.
   */
  private async bootstrap(): Promise<void> {
    const { bootstrapAdminEmail, bootstrapAdminPassword } =
      this.config.security;

    const existing = await this.db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.schema}.admin_users`,
    );
    if (Number(existing?.count ?? 0) > 0) return;

    if (!bootstrapAdminEmail || !bootstrapAdminPassword) {
      this.logger.warn(
        'No dashboard account exists and BOOTSTRAP_ADMIN_EMAIL / ' +
          'BOOTSTRAP_ADMIN_PASSWORD are not set. Nobody can sign in.',
      );
      return;
    }

    if (bootstrapAdminPassword.length < 12) {
      this.logger.error(
        'BOOTSTRAP_ADMIN_PASSWORD is shorter than 12 characters. Refusing to create ' +
          'the first account with it.',
      );
      return;
    }

    await this.createUser(
      bootstrapAdminEmail,
      bootstrapAdminPassword,
      'Bootstrap admin',
      'owner',
    );

    this.logger.log(
      `Created the first dashboard account for ${bootstrapAdminEmail}. ` +
        'Change the password and remove BOOTSTRAP_ADMIN_PASSWORD from the environment.',
    );
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toUser(row: AdminRow): AdminUser {
  return {
    id: Number(row.id),
    email: row.email,
    name: row.name,
    role: row.role as AdminRole,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
  };
}
