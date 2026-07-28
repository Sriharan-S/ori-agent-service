import { Controller, Get, NotFoundException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC_DIR = join(__dirname, '..', '..', 'public');

const ASSETS: Record<string, { file: string; type: string }> = {
  '/admin': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/admin/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/admin/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

/**
 * Serves the operator console.
 *
 * Three files, read from a fixed map rather than resolved from the request
 * path — there is no way to ask this for a file that is not on the list, so
 * traversal is not a thing it can do. Files are cached in memory after the
 * first read.
 *
 * The console is a static page. Everything it shows comes from `/admin/api`,
 * which is session-guarded, so serving the shell unauthenticated leaks nothing.
 */
@Controller()
export class DashboardController {
  private readonly cache = new Map<string, string>();

  @Get('admin')
  index(@Res() response: Response): void {
    this.send('/admin', response);
  }

  @Get('admin/styles.css')
  styles(@Res() response: Response): void {
    this.send('/admin/styles.css', response);
  }

  @Get('admin/app.js')
  script(@Res() response: Response): void {
    this.send('/admin/app.js', response);
  }

  private send(key: string, response: Response): void {
    const asset = ASSETS[key];
    if (!asset) throw new NotFoundException();

    let body = this.cache.get(key);
    if (body === undefined) {
      try {
        body = readFileSync(join(PUBLIC_DIR, asset.file), 'utf8');
      } catch {
        throw new NotFoundException(
          'Console assets are missing from the build. Check that public/ was copied.',
        );
      }
      this.cache.set(key, body);
    }

    response
      .status(200)
      .setHeader('content-type', asset.type)
      // The console must not be framed by another site, and it loads nothing
      // from anywhere else.
      .setHeader('x-frame-options', 'DENY')
      .setHeader(
        'content-security-policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; " +
          "img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
      )
      .send(body);
  }
}
