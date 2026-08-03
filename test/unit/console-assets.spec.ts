import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC_DIR = join(__dirname, '..', '..', 'public');
const CONTROLLER = join(
  __dirname,
  '..',
  '..',
  'src',
  'admin',
  'dashboard.controller.ts',
);

/**
 * Every console module must be reachable over HTTP.
 *
 * The console is served by a fixed route per file — deliberately, so the
 * controller cannot be asked for a path it does not know. The cost of that
 * design is that adding a file to `public/` is only half the job, and forgetting
 * the other half fails in the worst way available: the browser 404s one module,
 * the whole ES module graph fails to evaluate, and the console renders *nothing
 * at all*. Not a broken page — a blank one, with the only evidence in a console
 * nobody has open.
 *
 * That is exactly how `knowledge.js` shipped. The boot log listed every mapped
 * route and simply did not include it, which is not something you notice by
 * reading forty lines of `RouterExplorer` output.
 */
describe('console assets', () => {
  const source = readFileSync(CONTROLLER, 'utf8');

  const modules = readdirSync(PUBLIC_DIR).filter(
    (file) => file.endsWith('.js') || file.endsWith('.css') || file.endsWith('.html'),
  );

  it('finds the console files', () => {
    expect(modules.length).toBeGreaterThan(5);
  });

  it.each(modules)('%s is registered in the asset map', (file) => {
    expect(source).toContain(`file: '${file}'`);
  });

  it.each(modules.filter((file) => file !== 'index.html'))(
    '%s has a route',
    (file) => {
      expect(source).toContain(`@Get('admin/${file}')`);
    },
  );

  /**
   * The other half of the same mistake: a route serving a file that is not
   * there. It fails less catastrophically — one 404 rather than a blank console
   * — but only because the import that needed it would already have failed.
   */
  it('registers nothing that does not exist', () => {
    const registered = [...source.matchAll(/file: '([^']+)'/g)].map(
      (match) => match[1]!,
    );

    expect(registered.length).toBeGreaterThan(5);
    for (const file of registered) {
      expect(modules).toContain(file);
    }
  });

  /**
   * A module imported by the console but never served is the same failure by a
   * different route in. Checked against the imports rather than the directory,
   * so a file that exists but is unused does not have to be registered.
   */
  it('serves every module the console imports', () => {
    const imports = new Set<string>();

    for (const file of modules.filter((name) => name.endsWith('.js'))) {
      const body = readFileSync(join(PUBLIC_DIR, file), 'utf8');
      for (const match of body.matchAll(/from\s+'\.\/([^']+\.js)'/g)) {
        imports.add(match[1]!);
      }
    }

    expect(imports.size).toBeGreaterThan(3);
    for (const imported of imports) {
      expect(source).toContain(`@Get('admin/${imported}')`);
    }
  });
});
