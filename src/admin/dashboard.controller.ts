import { Controller, Get, Inject, NotFoundException, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, type AppConfig } from '../config/configuration';

const PUBLIC_DIR = join(__dirname, '..', '..', 'public');

/**
 * The console's files, by route.
 *
 * A fixed map rather than a path resolved from the request: there is no way to
 * ask this controller for a file that is not on the list, so traversal is not
 * something it can do. Each route is declared explicitly rather than using a
 * `:file` parameter, which would compete with `/admin/api/*` for matching.
 */
const ASSETS: Record<string, { file: string; type: string }> = {
  index: { file: 'index.html', type: 'text/html; charset=utf-8' },
  styles: { file: 'styles.css', type: 'text/css; charset=utf-8' },
  theme: { file: 'theme.js', type: 'text/javascript; charset=utf-8' },
  app: { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  ui: { file: 'ui.js', type: 'text/javascript; charset=utf-8' },
  views: { file: 'views.js', type: 'text/javascript; charset=utf-8' },
  setup: { file: 'setup.js', type: 'text/javascript; charset=utf-8' },
  editor: { file: 'function-editor.js', type: 'text/javascript; charset=utf-8' },
  guide: { file: 'guide.js', type: 'text/javascript; charset=utf-8' },
};

/**
 * Serves the operator console.
 *
 * A static page: everything it shows comes from `/admin/api`, which is
 * session-guarded, so serving the shell unauthenticated leaks nothing. The one
 * exception is `/admin/api/setup`, which answers before any account exists —
 * see `SetupController` for what it will and will not reveal.
 */
@ApiExcludeController()
@Controller()
export class DashboardController {
  private readonly cache = new Map<string, string>();

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  @Get('admin')
  index(@Res() response: Response): void {
    this.send('index', response);
  }

  @Get('admin/styles.css')
  styles(@Res() response: Response): void {
    this.send('styles', response);
  }

  @Get('admin/theme.js')
  theme(@Res() response: Response): void {
    this.send('theme', response);
  }

  @Get('admin/app.js')
  app(@Res() response: Response): void {
    this.send('app', response);
  }

  @Get('admin/ui.js')
  ui(@Res() response: Response): void {
    this.send('ui', response);
  }

  @Get('admin/views.js')
  views(@Res() response: Response): void {
    this.send('views', response);
  }

  @Get('admin/setup.js')
  setup(@Res() response: Response): void {
    this.send('setup', response);
  }

  @Get('admin/function-editor.js')
  editor(@Res() response: Response): void {
    this.send('editor', response);
  }

  @Get('admin/guide.js')
  guide(@Res() response: Response): void {
    this.send('guide', response);
  }

  private send(key: string, response: Response): void {
    const asset = ASSETS[key];
    if (!asset) throw new NotFoundException();

    // In development the files are read every time, so editing the console does
    // not need a restart. Caching them in dev cost an hour of "why is my CSS
    // change doing nothing" once already.
    const cacheable = this.config.service.isProduction;

    let body = cacheable ? this.cache.get(key) : undefined;
    if (body === undefined) {
      try {
        body = readFileSync(join(PUBLIC_DIR, asset.file), 'utf8');
      } catch {
        throw new NotFoundException(
          `Console asset "${asset.file}" is missing from the build. Check that public/ was copied.`,
        );
      }
      if (cacheable) this.cache.set(key, body);
    }

    response
      .status(200)
      .setHeader('content-type', asset.type)
      .setHeader(
        'cache-control',
        cacheable ? 'public, max-age=300' : 'no-store, must-revalidate',
      )
      // The console must not be framed by another site, and it loads nothing
      // from anywhere else — no CDN, no font host, no analytics. That is also
      // why it still works when the network does not.
      .setHeader('x-frame-options', 'DENY')
      .setHeader(
        'content-security-policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; " +
          "img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
      )
      .send(body);
  }
}
