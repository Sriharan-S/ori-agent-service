/**
 * Domain-neutral identity.
 *
 * This service knows nothing about the shape of a host application's user
 * model. A user is an opaque id, a role name, and a bag of scope values whose
 * keys the application chose. Whether `org_id` means a company, a school or a
 * tenant is not the agent's business — it is a key that binds to a column.
 */

export interface EndUser {
  /** The host application's identifier for this user. Opaque to the agent. */
  id: string;
  /** Role name, matched against the application's own role table. */
  role: string;
  /**
   * Values the caller is scoped to, e.g. `{ org_id: 42 }`. A function that
   * declares a scope filter for a key not present here — and whose role is not
   * exempt — is refused rather than run unscoped.
   */
  scopes: Record<string, string | number>;
  displayName?: string;
  email?: string;
  /**
   * The end user's own token, when the application supplied one. Forwarded on
   * write actions so the host API applies its own permissions.
   */
  token?: string;
}

export interface Application {
  id: number;
  slug: string;
  name: string;
  endUserAuth: 'jwt' | 'asserted';
  jwtIssuer: string | null;
  jwtJwksUrl: string | null;
  jwtAudience: string | null;
  jwtSubjectClaim: string;
  jwtRoleClaim: string | null;
  /** Maps a scope key to the claim it is read from, e.g. `{org_id: 'org'}`. */
  jwtScopeClaims: Record<string, string>;
  isActive: boolean;
}

export type ApiKeyScope = 'chat' | 'manage' | 'trace';

export interface ApiKeyRecord {
  id: number;
  applicationId: number;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
}

export interface RoleRecord {
  id: number;
  applicationId: number;
  name: string;
  description: string | null;
  /** Function names, or ['*']. */
  allowedFunctions: string[];
  writeScopes: string[];
  /** Scope keys this role is exempt from. */
  unscopedKeys: string[];
}

/** Everything resolved before the orchestrator runs. */
export interface RequestContext {
  application: Application;
  apiKey: ApiKeyRecord;
  endUser: EndUser;
  role: RoleRecord;
  /** Correlates this agent run across logs, audit rows and the trace stream. */
  runId: string;
  requestId: string;
  /** Whether the caller may receive internal trace events. */
  traceEnabled: boolean;
}

export function hasScope(key: ApiKeyScope, record: ApiKeyRecord): boolean {
  return record.scopes.includes(key);
}

/** Redacted view for logs. Never log a token or a raw email. */
export function describeContext(
  context: RequestContext,
): Record<string, unknown> {
  return {
    application: context.application.slug,
    apiKey: context.apiKey.prefix,
    endUserId: context.endUser.id,
    role: context.endUser.role,
    scopeKeys: Object.keys(context.endUser.scopes),
    runId: context.runId,
    requestId: context.requestId,
  };
}
