// Copia public/ in dist/, calcola la versione dall'hash dei file e la scrive
// in js/version.js e nel service worker, insieme all'elenco dei file da precaricare.
// Uso: "node scripts/build.mjs clean" prima di tsc, "node scripts/build.mjs" dopo.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DIST = 'dist';

if (process.argv[2] === 'clean') {
  rmSync(DIST, { recursive: true, force: true });
  process.exit(0);
}

if (!existsSync(join(DIST, 'js', 'app.js'))) {
  console.error('dist/js/app.js mancante: esegui prima tsc.');
  process.exit(1);
}

cpSync('public', DIST, { recursive: true });

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const toUrl = (p) => './' + relative(DIST, p).split(sep).join('/');
const excluded = new Set(['./sw.js', './js/version.js']);
const files = walk(DIST).map((p) => [p, toUrl(p)]).filter(([, u]) => !excluded.has(u)).sort((a, b) => a[1].localeCompare(b[1]));

const hash = createHash('sha256');
for (const [p, u] of files) hash.update(u).update(readFileSync(p));
const version = hash.digest('hex').slice(0, 10);

writeFileSync(join(DIST, 'js', 'version.js'), `export const VERSION = '${version}';\n`);

const assets = ['./', ...files.map(([, u]) => u), './js/version.js'];
const swPath = join(DIST, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
if (!sw.includes("'__VERSION__'") || !sw.includes('/*__ASSETS__*/[]')) {
  console.error('Segnaposto mancanti in public/sw.js');
  process.exit(1);
}
writeFileSync(swPath, sw.replace("'__VERSION__'", `'${version}'`).replace('/*__ASSETS__*/[]', JSON.stringify(assets)));

console.log(`Build ${version}: ${assets.length} file nel precache.`);
