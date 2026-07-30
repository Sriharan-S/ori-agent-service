import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';

/**
 * Serves the API reference at `/docs`.
 *
 * Only the two integration surfaces are documented — the chat API a host
 * application calls, and the management API it administers its registry with.
 * The console's own endpoints are excluded: they are session-authenticated,
 * internal to the UI, and change whenever the UI does, so publishing them would
 * imply a stability promise that is not being made.
 *
 * `swagger-ui-express` bundles its assets, so the page loads with no external
 * request — the same constraint the console is built under.
 */
export function setupOpenApi(app: INestApplication, publicUrl: string): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
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
          'Every request carries an **API key** identifying the calling application,',
          'as `X-Api-Key` or `Authorization: Bearer <key>`.',
          '',
          'Chat requests additionally identify the **end user**, in whichever mode',
          'the application is configured for:',
          '',
          '- `jwt` — forward the user\'s token as `X-End-User-Token`; the service',
          '  verifies it against the application\'s configured JWKS.',
          '- `asserted` — supply `X-End-User` as JSON, e.g.',
          '  `{"id":"4821","role":"support","scopes":{"org_id":42}}`. This is trusted',
          '  because the API key authenticated the channel, so such keys must never',
          '  reach a browser.',
          '',
          '### Key scopes',
          '',
          '- `chat` — call the chat API',
          '- `manage` — read and change the function registry',
          '- `trace` — receive the agent\'s internal steps on the streaming endpoint',
        ].join('\n'),
      )
      .setVersion('1.0')
      .addServer(publicUrl)
      .addApiKey(
        { type: 'apiKey', name: 'X-Api-Key', in: 'header' },
        'api-key',
      )
      .addTag('chat', 'Ask the agent a question')
      .addTag('management', 'Administer functions, roles and services')
      .addTag('health', 'Liveness and readiness')
      .build(),
    { deepScanRoutes: true },
  );

  // Scan everything, then drop the console's own endpoints. They are
  // session-authenticated, internal to the UI, and change whenever it does —
  // publishing them would imply a stability promise that is not being made.
  document.paths = Object.fromEntries(
    Object.entries(document.paths).filter(
      ([path]) => !path.startsWith('/admin'),
    ),
  );

  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'Ori Agent — API reference',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      tryItOutEnabled: true,
    },
  });
}
