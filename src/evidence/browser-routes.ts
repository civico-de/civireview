import type { BrowserConfig } from '../config/schema.ts';
import type { DiffFile, SurfaceDiffReport } from './types.ts';

export interface DiscoverStandaloneRoutesInput {
  diffFiles: DiffFile[];
  surfaceDiff?: SurfaceDiffReport;
  prBody?: string;
  config: { browser: BrowserConfig };
}

export interface DiscoveredStandaloneRoutes {
  pages: string[];
  anonymousPages: string[];
  reason: string;
}

const FILE_EXT_RE =
  /\.(?:php|js|ts|tsx|jsx|css|scss|tpl|xml|json|html|md|rst|txt|yml|yaml|png|jpe?g|gif|svg|woff2?)$/i;
const ROUTE_MENTION_RE = /(?:^|[\s"'`(>])\/?(civicrm\/[^\s"'`<>()\\]+(?:\?[A-Za-z0-9_=&%+-]+)?)/g;

/**
 * Normalizes a candidate CiviCRM route string into `civicrm/...`, returning
 * `null` if it contains wildcards/placeholders (e.g. `%`, `{id}`) or looks like a file path.
 */
export function normalizeStandaloneRoute(raw: string): string | null {
  let s = raw.trim().replace(/^\/+/, '');
  // Strip trailing punctuation when extracted from prose/diff
  s = s.replace(/[.,;:)"'`\]]+$/, '');
  if (!s.toLowerCase().startsWith('civicrm/')) {
    return null;
  }
  const rest = s.slice('civicrm/'.length).replace(/\/+$/, '');
  if (!rest) return null;

  // Reject wildcards / route parameter placeholders
  const pathPart = s.split('?')[0] ?? s;
  if (/[%{}*$<>[\]]/.test(pathPart)) {
    return null;
  }
  if (FILE_EXT_RE.test(pathPart)) {
    return null;
  }

  return `civicrm/${rest}`;
}

function getActiveDiffLines(rawPatch: string): string {
  const active: string[] = [];
  for (const line of rawPatch.split(/\r?\n/)) {
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('@@ ') ||
      line.startsWith('-')
    ) {
      continue;
    }
    active.push(line.startsWith('+') || line.startsWith(' ') ? line.slice(1) : line);
  }
  return active.join('\n');
}

/**
 * Discovers Standalone browser routes to probe from explicit config/CLI flags,
 * live `surface-diff.json`, static Menu XML / Afform JSON / diff / PR body,
 * falling back to `civicrm/dashboard?reset=1` when UI assets changed.
 */
export function discoverStandaloneRoutes(
  input: DiscoverStandaloneRoutesInput,
): DiscoveredStandaloneRoutes {
  const { diffFiles, surfaceDiff, prBody, config } = input;
  const maxAuto = config.browser.maxAutoPages;

  const explicitPages: string[] = [];
  const explicitPageSet = new Set<string>();
  for (const raw of config.browser.pages) {
    const norm = normalizeStandaloneRoute(raw);
    if (norm && !explicitPageSet.has(norm)) {
      explicitPageSet.add(norm);
      explicitPages.push(norm);
    }
  }

  const explicitAnonPages: string[] = [];
  const explicitAnonSet = new Set<string>();
  for (const raw of config.browser.anonymousPages) {
    const norm = normalizeStandaloneRoute(raw);
    if (norm && !explicitAnonSet.has(norm)) {
      explicitAnonSet.add(norm);
      explicitAnonPages.push(norm);
    }
  }

  const autoPages: string[] = [];
  const autoPageSet = new Set<string>();
  const autoAnonPages: string[] = [];
  const autoAnonSet = new Set<string>();

  const addAutoPage = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const norm = normalizeStandaloneRoute(raw);
    if (norm && !explicitPageSet.has(norm) && !autoPageSet.has(norm)) {
      autoPageSet.add(norm);
      autoPages.push(norm);
    }
  };

  const addAutoAnon = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const norm = normalizeStandaloneRoute(raw);
    if (norm && !explicitAnonSet.has(norm) && !autoAnonSet.has(norm)) {
      autoAnonSet.add(norm);
      autoAnonPages.push(norm);
    }
  };

  let liveCount = 0;
  let staticXmlAfformCount = 0;
  let mentionCount = 0;

  // 1. Live surface-diff.json routes and Afforms
  const live = surfaceDiff?.liveSurfaceDiff;
  if (live) {
    for (const bucketKey of ['added', 'changed'] as const) {
      for (const item of live.routes?.[bucketKey] ?? []) {
        const beforeLen = autoPages.length;
        addAutoPage(item.path ?? item.route);
        if (autoPages.length > beforeLen) liveCount++;
      }
    }
    for (const bucketKey of ['added', 'changed'] as const) {
      for (const item of live.afform?.[bucketKey] ?? []) {
        const route = item.server_route;
        const beforeLen = autoPages.length;
        addAutoPage(route);
        if (autoPages.length > beforeLen) liveCount++;
        if (item.is_public === true) {
          addAutoAnon(route);
        }
      }
    }
  }

  // 2. Static parsing of touched Menu XML, Afform JSON, and diff mentions
  for (const file of diffFiles) {
    if (file.status === 'deleted') continue;
    const content = getActiveDiffLines(file.rawPatch);

    if (file.flags.isMenuXml) {
      const pathRe = /<path>\s*([^<]+?)\s*<\/path>/gi;
      for (const m of content.matchAll(pathRe)) {
        if (m[1]) {
          const beforeLen = autoPages.length;
          addAutoPage(m[1]);
          if (autoPages.length > beforeLen) staticXmlAfformCount++;
        }
      }
    }

    if (file.flags.isAfform || file.path.toLowerCase().endsWith('.aff.json')) {
      const routeRe = /"server_route"\s*:\s*"([^"]+)"/gi;
      const isPublic = /"is_public"\s*:\s*true\b/i.test(content);
      for (const m of content.matchAll(routeRe)) {
        if (m[1]) {
          const beforeLen = autoPages.length;
          addAutoPage(m[1]);
          if (autoPages.length > beforeLen) staticXmlAfformCount++;
          if (isPublic) {
            addAutoAnon(m[1]);
          }
        }
      }
    }

    for (const m of content.matchAll(ROUTE_MENTION_RE)) {
      if (m[1]) {
        const beforeLen = autoPages.length;
        addAutoPage(m[1]);
        if (autoPages.length > beforeLen) mentionCount++;
      }
    }
  }

  // 3. PR body mentions of civicrm/<route>
  if (prBody) {
    for (const m of prBody.matchAll(ROUTE_MENTION_RE)) {
      if (m[1]) {
        const beforeLen = autoPages.length;
        addAutoPage(m[1]);
        if (autoPages.length > beforeLen) mentionCount++;
      }
    }
  }

  // Cap auto-discovered routes at config.browser.maxAutoPages
  const cappedAutoPages = autoPages.slice(0, maxAuto);
  const cappedAutoAnon = autoAnonPages.slice(0, maxAuto);

  let usedFallback = false;
  if (
    explicitPages.length === 0 &&
    explicitAnonPages.length === 0 &&
    cappedAutoPages.length === 0 &&
    cappedAutoAnon.length === 0
  ) {
    const uiTouched = diffFiles.some(
      (f) => f.flags.isFrontendAsset || f.flags.isSmartyTemplate || f.flags.isAfform,
    );
    if (uiTouched) {
      cappedAutoPages.push('civicrm/dashboard?reset=1');
      usedFallback = true;
    }
  }

  const pages = [...explicitPages, ...cappedAutoPages];
  const anonymousPages = [...explicitAnonPages, ...cappedAutoAnon];

  const reasonParts: string[] = [];
  if (explicitPages.length > 0 || explicitAnonPages.length > 0) {
    reasonParts.push(`explicit (${explicitPages.length + explicitAnonPages.length})`);
  }
  if (liveCount > 0) reasonParts.push(`live surface (${liveCount})`);
  if (staticXmlAfformCount > 0) {
    reasonParts.push(`menu/afform (${staticXmlAfformCount})`);
  }
  if (mentionCount > 0) reasonParts.push(`diff/PR mentions (${mentionCount})`);
  if (usedFallback) {
    reasonParts.push('UI asset fallback (civicrm/dashboard?reset=1)');
  }

  const reason =
    reasonParts.length > 0 ? reasonParts.join(', ') : 'no UI routes or frontend assets touched';

  return {
    pages,
    anonymousPages,
    reason,
  };
}
