/**
 * Structural verification for this bundle, runnable without any dependency:
 *   node scripts/verify.mjs
 *
 * It checks the three places that must agree for a DSH bundle to load - the manifest, the patch row
 * and the Client module registration - plus the locale files, and reports any row id that already
 * exists in the machine's live profile patch (a collision would silently override that row).
 *
 * The patch is a controlled, three-line `insert` list, so it is read with a purpose-built scan here
 * instead of pulling in a YAML parser. The full YAML parse happens at install time and is also done
 * by `_migration/tools/verify-bundles.cjs` in the authoring workspace.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PROFILE_PATCH = 'C:/Users/xuanm/Desktop/dsh-settings/profiles/desktop/cordis.patch.yml';

const problems = [];
const notes = [];
const ok = (name) => console.log(`ok   ${name}`);
const bad = (name, detail) => { problems.push(`${name}: ${detail}`); console.log(`FAIL ${name}   [${detail}]`); };
const check = (name, condition, detail = '') => (condition ? ok(name) : bad(name, detail));

// ---------------------------------------------------------------- manifest
let pkg = null;
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  ok('package.json parses');
} catch (error) {
  bad('package.json parses', error.message);
}
if (pkg) {
  check('name is the bundle id the Client module registers', typeof pkg.name === 'string' && pkg.name.length > 0, String(pkg.name));
  check('dsh.bundle.patch is declared', Boolean(pkg.dsh?.bundle?.patch), JSON.stringify(pkg.dsh?.bundle));
  check('dsh.client targets the web platform', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform));
  for (const target of [pkg.exports?.['.'], pkg.exports?.['./client'], pkg.dsh?.bundle?.patch]) {
    if (!target) continue;
    check(`declared file exists: ${target}`, existsSync(join(ROOT, target)), 'missing on disk');
  }
}

// ---------------------------------------------------------------- patch rows
let rows = [];
if (pkg?.dsh?.bundle?.patch) {
  const text = readFileSync(join(ROOT, pkg.dsh.bundle.patch), 'utf8');
  const insertAt = text.indexOf('insert:');
  const body = insertAt >= 0 ? text.slice(insertAt) : '';
  const ids = [...body.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  const names = [...body.matchAll(/^\s*name:\s*'?([^'\s]+)'?\s*$/gm)].map((m) => m[1]);
  check('the patch is exactly one insert list', insertAt >= 0 && ids.length > 0, `ids=${ids.join(',') || 'none'}`);
  check('every inserted row has an id and a name', ids.length === names.length && ids.length > 0, `ids=${ids.length} names=${names.length}`);
  check('every inserted row names this package', names.every((name) => name === pkg.name), names.join(','));
  rows = ids.map((id, index) => ({ id, name: names[index] }));
}

// ---------------------------------------------------------------- client module
if (pkg?.name) {
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8');
  const loads = [...client.matchAll(/__ModuleLoader__\.load\(/g)].length;
  const registered = /const\s+SPEC\s*=\s*'([^']+)'/.exec(client);
  check('client.js registers exactly one module', loads === 1, `load() calls=${loads}`);
  check('the registered module id equals the package name', registered?.[1] === pkg.name, `registered=${registered?.[1]} package=${pkg.name}`);
}

// ---------------------------------------------------------------- locale
const localeDir = join(ROOT, 'locale');
if (existsSync(localeDir)) {
  const files = readdirSync(localeDir).filter((name) => name.endsWith('.json'));
  check('at least one locale file exists', files.length > 0, 'locale/ is empty');
  for (const name of files) {
    try {
      const locale = JSON.parse(readFileSync(join(localeDir, name), 'utf8'));
      check(`locale/${name} has title and description`, Boolean(locale.title && locale.description), JSON.stringify(locale));
    } catch (error) {
      bad(`locale/${name} parses`, error.message);
    }
  }
}

// ---------------------------------------------------------------- live profile collision
const profilePatch = process.env.DSH_PROFILE_PATCH || DEFAULT_PROFILE_PATCH;
if (existsSync(profilePatch) && rows.length > 0) {
  const liveText = readFileSync(profilePatch, 'utf8');
  const liveIds = new Set([...liveText.matchAll(/^\s*-?\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]));
  const collisions = rows.filter((row) => liveIds.has(row.id)).map((row) => row.id);
  check('no inserted row id collides with the live profile patch', collisions.length === 0, `collides: ${collisions.join(',')}`);
} else if (!existsSync(profilePatch)) {
  notes.push(`live profile patch not found (${profilePatch}); row-id collision not checked`);
}

for (const note of notes) console.log(`note ${note}`);
console.log(`\n${problems.length === 0 ? 'structure OK' : problems.length + ' problem(s)'}`);
process.exit(problems.length === 0 ? 0 : 1);
