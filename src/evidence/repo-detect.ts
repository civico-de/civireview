import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { RepoInfo } from './types.ts';

function parseXmlTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i'));
  return match?.[1]?.trim();
}

export function parseXmlAttr(xml: string, tag: string, attr: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match?.[1]?.trim();
}

/**
 * Selects the appropriate CiviKitchen Standalone Docker tag from a CiviCRM
 * version string or branch name.
 */
export function selectCivikitchenImage(params: {
  kind: RepoInfo['kind'];
  baseBranch?: string;
  civicrmVersion?: string;
  civicrmFloor?: string;
}): string {
  const { kind, baseBranch, civicrmVersion, civicrmFloor } = params;
  if (kind === 'civicrm-core') {
    const branch = (baseBranch ?? '').trim();
    if (branch === 'master' || branch === 'main') {
      return 'standalone-master';
    }
    if (/^\d+\.\d+$/.test(branch)) {
      return `standalone-${branch}`;
    }
    if (civicrmVersion) {
      const minorMatch = civicrmVersion.match(/^(\d+\.\d+)/);
      if (minorMatch?.[1]) {
        return `standalone-${minorMatch[1]}`;
      }
    }
    return 'standalone-master';
  }

  if (kind === 'civicrm-extension') {
    if (civicrmFloor) {
      const floorMatch = civicrmFloor.match(/^(\d+\.\d+)/);
      if (floorMatch?.[1]) {
        return `standalone-${floorMatch[1]}`;
      }
    }
    return 'standalone';
  }

  return 'standalone';
}

/**
 * Returns the CiviKitchen tags to try, preferred first. A core PR runs on its
 * branch's image or not at all; an extension may run on the newest stable.
 */
export function getCivikitchenImageCandidates(preferred: string, kind: RepoInfo['kind']): string[] {
  const substitutes = kind === 'civicrm-core' ? [] : ['standalone-latest', 'standalone'];
  return Array.from(new Set([preferred, ...substitutes]));
}

/**
 * Detects whether `repoRoot` is `civicrm-core`, a `civicrm-extension`, or `generic`,
 * extracting version/extension metadata and recommending the CiviKitchen Standalone image.
 */
export function detectRepoInfo(repoRoot: string, baseBranch?: string): RepoInfo {
  const versionXmlPath = join(repoRoot, 'xml', 'version.xml');
  const crmDirPath = join(repoRoot, 'CRM');
  if (existsSync(versionXmlPath) && existsSync(crmDirPath)) {
    const versionXml = readFileSync(versionXmlPath, 'utf8');
    const civicrmVersion = parseXmlTag(versionXml, 'version_no');
    return {
      kind: 'civicrm-core',
      root: repoRoot,
      civicrmVersion,
      recommendedImage: selectCivikitchenImage({
        kind: 'civicrm-core',
        baseBranch,
        civicrmVersion,
      }),
    };
  }

  const infoXmlPath = join(repoRoot, 'info.xml');
  const civikitchenYamlPath = join(repoRoot, 'civikitchen.yaml');
  if (existsSync(infoXmlPath) || existsSync(civikitchenYamlPath)) {
    let extensionKey: string | undefined;
    let extensionName: string | undefined;
    let civicrmFloor: string | undefined;

    if (existsSync(infoXmlPath)) {
      const infoXml = readFileSync(infoXmlPath, 'utf8');
      extensionKey = parseXmlAttr(infoXml, 'extension', 'key');
      extensionName = parseXmlTag(infoXml, 'file') ?? extensionKey;
    }

    if (existsSync(civikitchenYamlPath)) {
      try {
        // Failsafe schema keeps every scalar a string, so `civicrm: 6.10` stays "6.10".
        const raw = yaml.load(readFileSync(civikitchenYamlPath, 'utf8'), {
          schema: yaml.FAILSAFE_SCHEMA,
        });
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const obj = raw as Record<string, unknown>;
          const policy = obj.policy;
          if (policy && typeof policy === 'object' && !Array.isArray(policy)) {
            const civi = (policy as Record<string, unknown>).civicrm;
            if (typeof civi === 'string' && civi.trim()) {
              civicrmFloor = civi.trim();
            }
          }
        }
      } catch {
        // Malformed civikitchen.yaml should not crash repo detection
      }
    }

    return {
      kind: 'civicrm-extension',
      root: repoRoot,
      extensionKey,
      extensionName,
      civicrmFloor,
      recommendedImage: selectCivikitchenImage({
        kind: 'civicrm-extension',
        baseBranch,
        civicrmFloor,
      }),
    };
  }

  return {
    kind: 'generic',
    root: repoRoot,
    recommendedImage: 'standalone',
  };
}

export type ReviewProfile = 'core' | 'core-extension' | 'extension' | 'generic';

/**
 * Names the review profile: which mounts, checks and wording a PR gets.
 * `core-extension` is a civicrm-core PR that touches a bundled extension under `ext/`.
 */
export function reviewProfile(info: RepoInfo): ReviewProfile {
  if (info.kind === 'civicrm-core') {
    return (info.bundledExtensions?.length ?? 0) > 0 ? 'core-extension' : 'core';
  }
  return info.kind === 'civicrm-extension' ? 'extension' : 'generic';
}

/**
 * Finds the bundled extensions a civicrm-core diff touches: the nearest directory
 * under `ext/` holding an `info.xml`, in the checkout or added by the diff itself.
 */
export function detectBundledExtensions(repoRoot: string, diffPaths: string[]): string[] {
  const added = new Set(diffPaths);
  const hasInfoXml = (dir: string) =>
    added.has(`${dir}/info.xml`) || existsSync(join(repoRoot, dir, 'info.xml'));
  const roots = new Set<string>();
  for (const p of diffPaths) {
    const parts = p.split('/');
    if (parts[0] !== 'ext' || parts.length < 3) continue;
    // Nested extensions (ext/afform/core) win over their parent directory.
    const nested = parts.length > 3 ? parts.slice(0, 3).join('/') : undefined;
    const top = parts.slice(0, 2).join('/');
    if (nested && hasInfoXml(nested)) roots.add(nested);
    else if (hasInfoXml(top)) roots.add(top);
  }
  return Array.from(roots).toSorted();
}
