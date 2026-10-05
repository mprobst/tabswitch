/**
 * Releases a new version of the extension:
 *
 *   npm run release -- <patch|minor|major> [--dry-run] [--no-store] [--skip-ci]
 *
 * 1. Checks that `main` is clean, up to date and passed CI, and runs
 *    `npm run check`.
 * 2. Bumps the version in manifest.json, package.json and package-lock.json.
 * 3. Builds the Web Store zip (`npm run bundle`, which writes `<name>.zip`).
 * 4. Commits "Release vX.Y.Z" with release notes (the commit subjects since
 *    the previous release), tags it, and pushes both.
 * 5. Creates a GitHub release with the zip attached.
 * 6. Uploads the zip to the Chrome Web Store and submits it for review.
 *
 * The Web Store upload needs OAuth credentials in the environment (or in a
 * `.env` file, which is git-ignored): CLIENT_ID, CLIENT_SECRET and
 * REFRESH_TOKEN. See https://github.com/fregante/chrome-webstore-upload-keys
 * for how to get them. The extension and publisher IDs (from the Web Store
 * developer console URL) are `webStore.extensionId` and
 * `webStore.publisherId` in package.json; PUBLISHER_ID in the environment
 * also works.
 *
 * `--dry-run` only runs the checks and prints what would happen.
 * `--no-store` skips the Web Store upload, e.g. to upload by hand.
 * `--skip-ci` releases even if CI hasn't passed (yet) for the commit, e.g.
 * while GitHub Actions is down; `npm run check` still runs locally.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

type Bump = 'patch' | 'minor' | 'major';
const BUMPS: readonly string[] = ['patch', 'minor', 'major'] satisfies Bump[];
const STORE_SECRETS = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN'];
const USAGE = 'usage: npm run release -- <patch|minor|major> [--dry-run] [--no-store] [--skip-ci]';

/** Runs a command, showing its output. Throws if it fails. */
function runShowingOutput(command: string, args: string[]) {
  console.log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit' });
}

/** Runs a command and returns its trimmed output. Throws (with its stderr) if it fails. */
function runCapturingOutput(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

/** Returns `version` with the given part incremented, e.g. 0.2 + minor = 0.3.0. */
export function bumpVersion(version: string, bump: Bump): string {
  const parts = version.split('.').map(Number);
  if (parts.length > 3 || parts.some((p) => !Number.isInteger(p) || p < 0)) {
    throw new Error(`unsupported version "${version}", expected up to three numbers`);
  }
  const [major = 0, minor = 0, patch = 0] = parts;
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
  }
}

/** Returns the CI status of `commit`, e.g. "completed success <url>", or "" if there is no run. */
function ciStatus(commit: string): string {
  try {
    return runCapturingOutput('gh', [
      ...['run', 'list', '--workflow', 'ci.yml', '--commit', commit, '--limit', '1'],
      ...['--json', 'status,conclusion,url'],
      ...['--jq', '.[0] // {} | [.status, .conclusion, .url] | join(" ")'],
    ]);
  } catch (e) {
    fail(`could not get the CI status of ${commit.slice(0, 7)}: ${String(e)}`);
  }
}

/** Release notes: the subjects of all commits since the previous release tag. */
function releaseNotes(): string {
  let range = 'HEAD';
  try {
    range = `${runCapturingOutput('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'])}..HEAD`;
  } catch {
    // No release tag yet: everything so far.
  }
  return runCapturingOutput('git', ['log', '--no-merges', '--format=- %s', range]);
}

function main(argv: string[]) {
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
  const bump = argv.find((a) => !a.startsWith('--'));
  const dryRun = argv.includes('--dry-run');
  const store = !argv.includes('--no-store');
  const skipCi = argv.includes('--skip-ci');
  if (!bump || !BUMPS.includes(bump)) fail(USAGE);
  const unknown = argv.filter(
    (a) => a.startsWith('--') && !['--dry-run', '--no-store', '--skip-ci'].includes(a),
  );
  if (unknown.length > 0) fail(`unknown option ${unknown.join(', ')}; ${USAGE}`);

  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
    name: string;
    webStore?: { extensionId?: string; publisherId?: string };
  };
  const manifestText = fs.readFileSync('manifest.json', 'utf8');
  const manifest = JSON.parse(manifestText) as { version: string };
  const extensionId = pkg.webStore?.extensionId;
  const publisherId = pkg.webStore?.publisherId ?? process.env['PUBLISHER_ID'];
  const zip = `${pkg.name}.zip`;

  // Preconditions, before changing anything.
  if (runCapturingOutput('git', ['branch', '--show-current']) !== 'main') fail('not on main');
  if (runCapturingOutput('git', ['status', '--porcelain'])) {
    fail('the working tree has uncommitted changes');
  }
  runShowingOutput('git', ['fetch', 'origin', 'main', '--tags']);
  if (
    runCapturingOutput('git', ['rev-parse', 'HEAD']) !==
    runCapturingOutput('git', ['rev-parse', 'origin/main'])
  ) {
    fail('main is not the same as origin/main; pull or push first');
  }
  runShowingOutput('gh', ['auth', 'status']);
  const head = runCapturingOutput('git', ['rev-parse', 'HEAD']);
  const ci = ciStatus(head);
  if (!ci.startsWith('completed success')) {
    const problem = `CI hasn't passed for ${head.slice(0, 7)}: ${ci || 'no run found'}`;
    if (!skipCi) fail(`${problem} (--skip-ci to release anyway)`);
    console.warn(`release: ${problem}; releasing anyway (--skip-ci)`);
  }
  if (store) {
    const missing = STORE_SECRETS.filter((name) => !process.env[name]);
    if (missing.length > 0) fail(`missing ${missing.join(', ')} for the Web Store upload`);
    if (!extensionId) fail('webStore.extensionId is not set in package.json');
    if (!publisherId) fail('webStore.publisherId is not set in package.json');
  }
  runShowingOutput('npm', ['run', 'check']);

  const version = bumpVersion(manifest.version, bump as Bump);
  const tag = `v${version}`;
  const notes = releaseNotes();
  console.log(`\nReleasing ${pkg.name} ${manifest.version} -> ${version}\n\n${notes}\n`);
  if (dryRun) {
    console.log('Dry run; stopping here.');
    return;
  }

  // Edit manifest.json in place, to keep its formatting.
  fs.writeFileSync(
    'manifest.json',
    manifestText.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`),
  );
  runShowingOutput('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);
  runShowingOutput('npm', ['run', 'bundle']);

  const message = `Release ${tag}\n\n${notes}\n`;
  runShowingOutput('git', [
    'commit',
    '--quiet',
    '-m',
    message,
    'manifest.json',
    'package.json',
    'package-lock.json',
  ]);
  runShowingOutput('git', ['tag', '--annotate', tag, '-m', message]);
  runShowingOutput('git', ['push', '--atomic', 'origin', 'main', tag]);

  // From here on, the release exists; on failure, say how to finish by hand.
  const remaining: string[][] = [
    ['gh', 'release', 'create', tag, zip, '--title', tag, '--notes-from-tag'],
  ];
  if (store && extensionId && publisherId) {
    remaining.push([
      ...['npx', 'chrome-webstore-upload', '--source', zip],
      ...['--extension-id', extensionId, '--publisher-id', publisherId],
    ]);
  }
  while (remaining.length > 0) {
    const [command, ...args] = remaining[0]!;
    try {
      runShowingOutput(command!, args);
    } catch (e) {
      console.error(`\nrelease: ${String(e)}\n${tag} is pushed. Finish the release with:`);
      for (const step of remaining) console.error(`  ${step.join(' ')}`);
      process.exit(1);
    }
    remaining.shift();
  }
  console.log(`\nReleased ${tag}.`);
}

if (import.meta.main) main(process.argv.slice(2));
