import type { DiffFile } from './types.ts';

/** The CMS flavors `ck demo --cms` can boot besides Standalone. */
export const RUNNABLE_CMS = ['joomla', 'wordpress', 'drupal10', 'backdrop'] as const;
export type RunnableCms = (typeof RUNNABLE_CMS)[number];

export interface CmsOfPath {
  label: string;
  // Absent when no image runs that integration (Drupal 7).
  cms?: RunnableCms;
}

export interface CmsScope {
  // One entry per CMS integration the changed code belongs to.
  hits: CmsOfPath[];
  labels: string[];
  runnable: RunnableCms[];
  files: string[];
  // True when every changed code file belongs to a CMS integration other than Standalone.
  onlyCms: boolean;
}

const CMS_LABELS: Record<RunnableCms, string> = {
  joomla: 'Joomla',
  wordpress: 'WordPress',
  drupal10: 'Drupal',
  backdrop: 'Backdrop',
};

const DRUPAL: CmsOfPath = { label: 'Drupal', cms: 'drupal10' };
const DRUPAL7: CmsOfPath = { label: 'Drupal 7' };
const BACKDROP: CmsOfPath = { label: 'Backdrop', cms: 'backdrop' };

export function cmsLabel(cms: string): string {
  return CMS_LABELS[cms as RunnableCms] ?? cms;
}

/**
 * The CMS integrations a path belongs to, read from its file name and directories
 * (`CRM/Utils/System/Joomla.php`, `css/wordpress.css`). Empty for shared and Standalone code.
 */
export function cmsOfPath(filePath: string): CmsOfPath[] {
  const segments = filePath.replaceAll('\\', '/').split('/');
  const base = segments.at(-1) ?? '';
  for (const segment of segments) {
    if (/joomla/i.test(segment)) return [{ label: 'Joomla', cms: 'joomla' }];
    if (/wordpress/i.test(segment)) return [{ label: 'WordPress', cms: 'wordpress' }];
    if (/backdrop/i.test(segment)) return [BACKDROP];
  }
  if (/^Drupal6?\.php$/.test(base)) return [DRUPAL7];
  // Core's Drupal 7 and Backdrop classes extend the `DrupalBase` ones.
  if (base.startsWith('DrupalBase.')) return [DRUPAL, DRUPAL7, BACKDROP];
  if (segments.some((s) => /drupal/i.test(s))) return [DRUPAL];
  return [];
}

/** Which CMS integrations the changed code files belong to; tests and docs do not count. */
export function cmsScope(diffFiles: DiffFile[]): CmsScope {
  const code = diffFiles.filter((f) => !f.flags.isTest && !f.flags.isDocsOnly);
  const byLabel = new Map<string, CmsOfPath>();
  const files: string[] = [];
  for (const file of code) {
    const found = cmsOfPath(file.path);
    if (found.length === 0) continue;
    for (const hit of found) byLabel.set(hit.label, hit);
    files.push(file.path);
  }
  const hits = [...byLabel.values()];
  return {
    hits,
    labels: hits.map((h) => h.label),
    runnable: hits.flatMap((h) => (h.cms ? [h.cms] : [])),
    files,
    onlyCms: code.length > 0 && files.length === code.length,
  };
}
