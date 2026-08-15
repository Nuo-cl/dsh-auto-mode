/**
 * Sync the built plugin into the profile's installed copy.
 *
 * pnpm `file:` dependencies are COPIED at install time, so builds are not
 * visible until this sync runs. The profile dependency is `link:`-ready, but
 * while it is still `file:`, run this after every `npm run build`:
 *
 *   node scripts/sync-profile.mjs [profile]
 *
 * Copies lib/, package.json and cordis.patch.yml into
 * `~/.dsh/profiles/<profile>/node_modules/dsh-auto-mode`.
 */
import { cpSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const profile = process.argv[2] ?? 'web';
const project = resolve(import.meta.dirname, '..');
const target = join(
  homedir(),
  '.dsh',
  'profiles',
  profile,
  'node_modules',
  'dsh-auto-mode',
);

if (!existsSync(target)) {
  console.error(`target not found: ${target}`);
  process.exit(1);
}

for (const entry of ['lib', 'package.json', 'cordis.patch.yml']) {
  const from = join(project, entry);
  const to = join(target, entry);
  cpSync(from, to, { recursive: true, force: true });
  console.log(`synced ${entry}`);
}

console.log(`\ndsh-auto-mode synced to profile "${profile}". Restart DSH to load it.`);
