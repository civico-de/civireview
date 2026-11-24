import { getCivikitchenImageCandidates } from '../repo-detect.ts';
import type { RepoInfo } from '../types.ts';
import type { ExecFn } from './parsers.ts';

const CIVIKITCHEN_IMAGE_REPO = 'ghcr.io/civico-de/civikitchen';
const CIVICRM_SOURCE_LOG = '/usr/local/share/civikitchen/civicrm-source.log';

export function civikitchenImageRef(tag: string): string {
  return tag.includes('/') || tag.includes(':') ? tag : `${CIVIKITCHEN_IMAGE_REPO}:${tag}`;
}

const CORE_COMPOSER_INPUTS = '/var/www/html/core/vendor/.civikitchen-composer-inputs';

/**
 * Names the civicrm-core commit an image holds (the `git .` line of its source
 * log, or the release tag of its tarball) and whether its entrypoint syncs
 * vendor/ to mounted core composer files.
 */
export async function readImageCore(
  imageTag: string,
  execFn: ExecFn,
): Promise<{ ref?: string; vendorSync: boolean }> {
  const res = await execFn(
    [
      'docker',
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      civikitchenImageRef(imageTag),
      '-c',
      `cat ${CIVICRM_SOURCE_LOG} && if [ -f ${CORE_COMPOSER_INPUTS} ]; then echo vendor-sync; fi`,
    ],
    { timeoutMs: 600_000 },
  );
  if (res.exitCode !== 0) return { vendorSync: false };
  const vendorSync = /^vendor-sync$/m.test(res.stdout);
  const git = res.stdout.match(/^git \. ([0-9a-f]{40})$/m);
  const ref = git?.[1] ?? res.stdout.match(/^tarball \S*\/civicrm-(\d+\.\d+\.\d+)-/m)?.[1];
  return { ref, vendorSync };
}

/**
 * Lists the core paths that differ between the image's core and `baseSha`, so
 * A runs on the base itself however old or new the image is. `files` stays
 * undefined when the image's core commit cannot be resolved in `repoRoot`.
 */
export async function collectBaseDriftSinceImage(params: {
  repoRoot: string;
  baseSha: string;
  imageTag: string;
  execFn: ExecFn;
}): Promise<{ imageCoreRef?: string; files?: string[]; vendorSync: boolean }> {
  const { execFn } = params;
  const { ref: imageCoreRef, vendorSync } = await readImageCore(params.imageTag, execFn);
  if (!imageCoreRef) return { vendorSync };

  const isCommit = /^[0-9a-f]{40}$/.test(imageCoreRef);
  const rev = isCommit ? imageCoreRef : `refs/tags/${imageCoreRef}`;
  const git = (args: string[], timeoutMs: number) =>
    execFn(['git', '-C', params.repoRoot, ...args], { timeoutMs });
  if ((await git(['cat-file', '-e', `${rev}^{commit}`], 10_000)).exitCode !== 0) {
    await git(['fetch', '--no-tags', 'origin', isCommit ? rev : `${rev}:${rev}`], 120_000);
  }
  const diff = await git(['diff', '--no-renames', '--name-only', rev, params.baseSha], 30_000);
  if (diff.exitCode !== 0) return { imageCoreRef, vendorSync };
  const files = diff.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { imageCoreRef, files, vendorSync };
}

/**
 * Verifies that the preferred CiviKitchen image tag exists (locally or in GHCR)
 * before launching `ck ab`. Only extensions may run on a substitute tag; the
 * caller reports the substitution.
 */
export async function resolveAvailableCivikitchenImage(
  preferred: string,
  kind: RepoInfo['kind'],
  execFn: ExecFn,
): Promise<{ tag: string; found: boolean; fallbackFrom?: string }> {
  for (const tag of getCivikitchenImageCandidates(preferred, kind)) {
    const ref = civikitchenImageRef(tag);
    const local = await execFn(['docker', 'image', 'inspect', ref], { timeoutMs: 5_000 });
    const remote =
      local.exitCode === 0
        ? local
        : await execFn(['docker', 'manifest', 'inspect', ref], { timeoutMs: 10_000 });
    if (remote.exitCode === 0) {
      return { tag, found: true, fallbackFrom: tag === preferred ? undefined : preferred };
    }
  }
  return { tag: preferred, found: false };
}
