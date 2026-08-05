import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import type {
  OperationObject,
  PathItemObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ADMIN_SESSION_COOKIE } from '../admin/admin-session.guard';

type HttpMethod = 'get' | 'post' | 'put' | 'delete';
type AuthScheme = 'none' | 'api-key' | 'admin-session';

interface RouteDoc {
  method: HttpMethod;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  auth: AuthScheme;
}

const ROUTES: RouteDoc[] = [
  { method: 'get', path: '/health', tag: 'health', summary: 'Liveness check', auth: 'none' },
  { method: 'get', path: '/ready', tag: 'health', summary: 'Readiness check', auth: 'none' },
  { method: 'post', path: '/v1/chat', tag: 'chat', summary: 'Ask a question', auth: 'api-key' },
  { method: 'post', path: '/v1/chat/stream', tag: 'chat', summary: 'Ask a question, streamed', auth: 'api-key' },
  { method: 'post', path: '/v1/chat/feedback', tag: 'chat', summary: 'Rate an answer', auth: 'api-key' },
  { method: 'get', path: '/v1/manage/functions', tag: 'management', summary: 'List functions', auth: 'api-key' },
  { method: 'get', path: '/v1/manage/functions/{name}', tag: 'management', summary: 'Fetch one function', auth: 'api-key' },
  { method: 'post', path: '/v1/manage/functions/check', tag: 'management', summary: 'Validate a function without saving it', auth: 'api-key' },
  { method: 'post', path: '/v1/manage/functions', tag: 'management', summary: 'Create a draft function', auth: 'api-key' },
  { method: 'put', path: '/v1/manage/functions/{name}', tag: 'management', summary: 'Update a function and return it to draft', auth: 'api-key' },
  { method: 'post', path: '/v1/manage/functions/{name}/status', tag: 'management', summary: 'Promote, disable, or retire a function', auth: 'api-key' },
  { method: 'get', path: '/v1/manage/functions/{name}/versions', tag: 'management', summary: 'List function versions', auth: 'api-key' },
  { method: 'delete', path: '/v1/manage/functions/{name}', tag: 'management', summary: 'Delete a function', auth: 'api-key' },
  { method: 'get', path: '/v1/manage/roles', tag: 'management', summary: 'List roles', auth: 'api-key' },
  { method: 'put', path: '/v1/manage/roles/{name}', tag: 'management', summary: 'Create or update a role', auth: 'api-key' },
  { method: 'delete', path: '/v1/manage/roles/{name}', tag: 'management', summary: 'Delete a role', auth: 'api-key' },
  { method: 'get', path: '/v1/manage/services', tag: 'management', summary: 'List HTTP action targets', auth: 'api-key' },
  { method: 'put', path: '/v1/manage/services/{name}', tag: 'management', summary: 'Register an HTTP action target', auth: 'api-key' },
  { method: 'delete', path: '/v1/manage/services/{name}', tag: 'management', summary: 'Remove an HTTP action target', auth: 'api-key' },
  { method: 'get', path: '/v1/manage/conversations', tag: 'management', summary: 'List conversations', auth: 'api-key' },
  { method: 'get', path: '/v1/manage/conversations/{key}', tag: 'management', summary: 'Fetch a conversation transcript', auth: 'api-key' },
  { method: 'get', path: '/admin/api/setup', tag: 'setup', summary: 'Read setup status', auth: 'none' },
  { method: 'post', path: '/admin/api/setup/check', tag: 'setup', summary: 'Re-check setup state', auth: 'none' },
  { method: 'get', path: '/admin/api/setup/sql', tag: 'setup', summary: 'Get setup SQL', auth: 'none' },
  { method: 'post', path: '/admin/api/setup/admin', tag: 'setup', summary: 'Create the first operator account', auth: 'none' },
  { method: 'post', path: '/admin/api/login', tag: 'console-session', summary: 'Start an operator session', auth: 'none' },
  { method: 'post', path: '/admin/api/logout', tag: 'console-session', summary: 'End the current operator session', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/me', tag: 'console-session', summary: 'Read the current operator', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/overview', tag: 'console-observability', summary: 'Read console overview metrics', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/runs/{runKey}', tag: 'console-observability', summary: 'Read one agent run', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/audit', tag: 'console-observability', summary: 'List audit log entries', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/database', tag: 'console-database', summary: 'Read database status', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/database/tables', tag: 'console-database', summary: 'List tables owned by the service', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications', tag: 'console-applications', summary: 'List applications', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications', tag: 'console-applications', summary: 'Create an application', auth: 'admin-session' },
  { method: 'put', path: '/admin/api/applications/{id}', tag: 'console-applications', summary: 'Update an application', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/functions/demo', tag: 'console-applications', summary: 'Install the demo function', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/services', tag: 'console-services', summary: 'List application HTTP action targets', auth: 'admin-session' },
  { method: 'put', path: '/admin/api/applications/{id}/services/{name}', tag: 'console-services', summary: 'Create or update an HTTP action target', auth: 'admin-session' },
  { method: 'delete', path: '/admin/api/applications/{id}/services/{name}', tag: 'console-services', summary: 'Delete an HTTP action target', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/keys', tag: 'console-api-keys', summary: 'List issued API keys', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/keys', tag: 'console-api-keys', summary: 'Issue an API key', auth: 'admin-session' },
  { method: 'delete', path: '/admin/api/keys/{id}', tag: 'console-api-keys', summary: 'Revoke an API key', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/feedback', tag: 'console-feedback', summary: 'List answer feedback', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/feedback/{feedbackId}', tag: 'console-feedback', summary: 'Read one feedback item', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/feedback/{feedbackId}/reviewed', tag: 'console-feedback', summary: 'Mark feedback reviewed or open', auth: 'admin-session' },
  { method: 'delete', path: '/admin/api/applications/{id}/feedback/{feedbackId}', tag: 'console-feedback', summary: 'Delete feedback', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/knowledge', tag: 'console-knowledge', summary: 'List knowledge documents', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/knowledge/{documentId}', tag: 'console-knowledge', summary: 'Read one knowledge document', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/knowledge/text', tag: 'console-knowledge', summary: 'Create a knowledge document from text', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/knowledge/upload', tag: 'console-knowledge', summary: 'Upload a knowledge document', auth: 'admin-session' },
  { method: 'put', path: '/admin/api/applications/{id}/knowledge/{documentId}/roles', tag: 'console-knowledge', summary: 'Update knowledge document roles', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/knowledge/{documentId}/reindex', tag: 'console-knowledge', summary: 'Re-index one knowledge document', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/knowledge/reindex', tag: 'console-knowledge', summary: 'Re-index all knowledge documents', auth: 'admin-session' },
  { method: 'delete', path: '/admin/api/applications/{id}/knowledge/{documentId}', tag: 'console-knowledge', summary: 'Delete a knowledge document', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/functions', tag: 'console-functions', summary: 'List application functions', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/functions/export', tag: 'console-functions', summary: 'Export functions as a bundle', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/functions/import', tag: 'console-functions', summary: 'Import a function bundle as drafts', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/functions/{name}', tag: 'console-functions', summary: 'Read one function and its versions', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/functions/check', tag: 'console-functions', summary: 'Validate a function without saving it', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/functions/{name}/try', tag: 'console-functions', summary: 'Try a function as a role', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/functions', tag: 'console-functions', summary: 'Create a draft function', auth: 'admin-session' },
  { method: 'put', path: '/admin/api/applications/{id}/functions/{name}', tag: 'console-functions', summary: 'Update a function and return it to draft', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/functions/{name}/status', tag: 'console-functions', summary: 'Promote, disable, or retire a function', auth: 'admin-session' },
  { method: 'delete', path: '/admin/api/applications/{id}/functions/{name}', tag: 'console-functions', summary: 'Delete a function', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/roles/{name}/scope-requirements', tag: 'console-roles', summary: 'Read role scope requirements', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/playground/stream', tag: 'console-playground', summary: 'Run the playground chat stream', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/applications/{id}/playground/feedback', tag: 'console-playground', summary: 'Rate a playground answer', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/roles', tag: 'console-roles', summary: 'List application roles', auth: 'admin-session' },
  { method: 'put', path: '/admin/api/applications/{id}/roles/{name}', tag: 'console-roles', summary: 'Create or update an application role', auth: 'admin-session' },
  { method: 'delete', path: '/admin/api/applications/{id}/roles/{name}', tag: 'console-roles', summary: 'Delete an application role', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/models', tag: 'console-models', summary: 'List model endpoints', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/models', tag: 'console-models', summary: 'Create a model endpoint', auth: 'admin-session' },
  { method: 'put', path: '/admin/api/models/{id}', tag: 'console-models', summary: 'Update a model endpoint', auth: 'admin-session' },
  { method: 'delete', path: '/admin/api/models/{id}', tag: 'console-models', summary: 'Delete a model endpoint', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/models/prefix-defaults', tag: 'console-models', summary: 'Read inferred embedding prefixes', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/models/test', tag: 'console-models', summary: 'Test unsaved model settings', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/models/health', tag: 'console-models', summary: 'Check model reachability', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/conversations', tag: 'console-conversations', summary: 'List application conversations', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/applications/{id}/conversations/{key}', tag: 'console-conversations', summary: 'Read one conversation', auth: 'admin-session' },
  { method: 'delete', path: '/admin/api/applications/{id}/conversations/{key}', tag: 'console-conversations', summary: 'Delete a conversation', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/conversations/{key}', tag: 'console-conversations', summary: 'Fetch a raw transcript', auth: 'admin-session' },
  { method: 'get', path: '/admin/api/admins', tag: 'console-operators', summary: 'List operator accounts', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/admins', tag: 'console-operators', summary: 'Create an operator account', auth: 'admin-session' },
  { method: 'post', path: '/admin/api/admins/{id}/password', tag: 'console-operators', summary: 'Set an operator password', auth: 'admin-session' },
];

const API_TAGS: Array<[string, string]> = [
  ['chat', 'Ask the agent a question'],
  ['management', 'Administer one application with an API key'],
  ['health', 'Liveness and readiness'],
  ['setup', 'Unauthenticated onboarding routes used before the first operator exists'],
  ['console-session', 'Operator login, logout, and current session'],
  ['console-observability', 'Dashboard metrics, runs, and audit log'],
  ['console-database', 'Database readiness and owned tables'],
  ['console-applications', 'Applications and demo setup'],
  ['console-services', 'Registered HTTP action targets'],
  ['console-api-keys', 'Issued integration API keys'],
  ['console-feedback', 'Answer ratings and review queue'],
  ['console-knowledge', 'Knowledge documents and indexing'],
  ['console-functions', 'Function registry authoring in the console'],
  ['console-roles', 'Application roles and scope requirements'],
  ['console-playground', 'Console-only chat playground'],
  ['console-models', 'Model endpoint configuration and health checks'],
  ['console-conversations', 'Conversation history'],
  ['console-operators', 'Operator account administration'],
];

/**
 * Serves the API reference at `/docs`.
 *
 * The document includes every JSON API exposed by the service:
 *
 *   - `/v1/*` integration routes authenticated by an application API key.
 *   - `/admin/api/setup/*` onboarding routes, intentionally unauthenticated
 *     before the first operator account exists.
 *   - `/admin/api/*` operator console routes authenticated by the session
 *     cookie set by `/admin/api/login`.
 *
 * The static console files served from `/admin` are still excluded. They are UI
 * assets rather than API operations.
 */
export function setupOpenApi(app: INestApplication, publicUrl: string): void {
  const builder = new DocumentBuilder()
    .setTitle('Ori Agent Service')
    .setDescription(
      [
        'An agentic LLM service over your own Postgres database.',
        '',
        'The model chooses a hand-written function and fills in its parameters.',
        'It never generates SQL and never reaches the database directly.',
        '',
        '### Authentication',
        '',
        'Integration routes under `/v1` carry an **API key** identifying the',
        'calling application, as `X-Api-Key` or `Authorization: Bearer <key>`.',
        '',
        'Chat requests additionally identify the **end user**, in whichever mode',
        'the application is configured for:',
        '',
        '- `jwt` - forward the user\'s token as `X-End-User-Token`; the service',
        '  verifies it against the application\'s configured JWKS.',
        '- `asserted` - supply `X-End-User` as JSON, e.g.',
        '  `{"id":"4821","role":"support","scopes":{"org_id":42}}`. This is trusted',
        '  because the API key authenticated the channel, so such keys must never',
        '  reach a browser.',
        '',
        'Operator routes under `/admin/api` use the `ori_admin_session` cookie',
        'set by `/admin/api/login`. Setup routes are intentionally unauthenticated',
        'until the first operator account exists, and mutating setup is refused',
        'once an account has been created.',
        '',
        '### Key scopes',
        '',
        '- `chat` - call the chat API',
        '- `manage` - read and change the function registry',
        '- `trace` - receive the agent\'s internal steps on the streaming endpoint',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addServer(publicUrl)
    .addApiKey(
      { type: 'apiKey', name: 'X-Api-Key', in: 'header' },
      'api-key',
    )
    .addCookieAuth(
      ADMIN_SESSION_COOKIE,
      {
        type: 'apiKey',
        name: ADMIN_SESSION_COOKIE,
        in: 'cookie',
        description: 'Operator session cookie set by POST /admin/api/login.',
      },
      'admin-session',
    );

  for (const [name, description] of API_TAGS) {
    builder.addTag(name, description);
  }

  const document = SwaggerModule.createDocument(app, builder.build(), {
    deepScanRoutes: true,
  });

  keepApiPaths(document);
  enrichRoutes(document);

  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'Ori Agent - API reference',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      tryItOutEnabled: true,
    },
  });
}

function keepApiPaths(document: OpenAPIObject): void {
  document.paths = Object.fromEntries(
    Object.entries(document.paths).filter(([path]) =>
      path === '/health' ||
      path === '/ready' ||
      path.startsWith('/v1/') ||
      path.startsWith('/admin/api'),
    ),
  );
}

function enrichRoutes(document: OpenAPIObject): void {
  for (const route of ROUTES) {
    const operation = findOperation(document.paths, route.path, route.method);
    if (!operation) continue;

    operation.tags = [route.tag];
    operation.summary = operation.summary || route.summary;
    operation.security = securityFor(route.auth);

    const notes = [operation.description, route.description, authDescription(route.auth)]
      .filter((entry): entry is string => Boolean(entry));
    operation.description = notes.join('\n\n');
  }

  for (const [path, item] of Object.entries(document.paths)) {
    forEachOperation(item, (method, operation) => {
      const documented = ROUTES.some(
        (route) => route.path === path && route.method === method,
      );
      if (documented) return;

      if (path.startsWith('/admin/api/setup')) {
        operation.tags ??= ['setup'];
        operation.security ??= [];
      } else if (path.startsWith('/admin/api')) {
        operation.tags ??= ['console-session'];
        operation.security ??= securityFor('admin-session');
      }
    });
  }

  markEventStream(document, '/v1/chat/stream');
  markEventStream(document, '/admin/api/applications/{id}/playground/stream');
  markKnowledgeUpload(document);
}

function findOperation(
  paths: OpenAPIObject['paths'],
  path: string,
  method: HttpMethod,
): OperationObject | undefined {
  return paths[path]?.[method];
}

function forEachOperation(
  item: PathItemObject,
  visit: (method: HttpMethod, operation: OperationObject) => void,
): void {
  for (const method of ['get', 'post', 'put', 'delete'] satisfies HttpMethod[]) {
    const operation = item[method];
    if (operation) visit(method, operation);
  }
}

function securityFor(auth: AuthScheme): OperationObject['security'] {
  if (auth === 'api-key') return [{ 'api-key': [] }];
  if (auth === 'admin-session') return [{ 'admin-session': [] }];
  return [];
}

function authDescription(auth: AuthScheme): string {
  if (auth === 'api-key') {
    return 'Authentication: application API key with the route\'s required scope.';
  }
  if (auth === 'admin-session') {
    return `Authentication: operator session cookie (${ADMIN_SESSION_COOKIE}).`;
  }
  return 'Authentication: none.';
}

function markEventStream(document: OpenAPIObject, path: string): void {
  const operation = findOperation(document.paths, path, 'post');
  if (!operation) return;

  operation.responses['200'] = {
    description: 'Server-Sent Events stream.',
    content: {
      'text/event-stream': {
        schema: { type: 'string' },
      },
    },
  };
}

function markKnowledgeUpload(document: OpenAPIObject): void {
  const operation = findOperation(
    document.paths,
    '/admin/api/applications/{id}/knowledge/upload',
    'post',
  );
  if (!operation) return;

  operation.requestBody = {
    required: true,
    description: 'Multipart upload. The file limit is 25 MiB.',
    content: {
      'multipart/form-data': {
        schema: {
          type: 'object',
          required: ['file'],
          properties: {
            file: { type: 'string', format: 'binary' },
            title: { type: 'string' },
            allowedRoles: {
              type: 'string',
              description: 'JSON array of role names. Omit for everyone.',
            },
          },
        },
      },
    },
  };
}
