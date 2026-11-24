import { describe, expect, test } from 'bun:test';
import { computeSurfaceDiff, mergeLiveSurfaceDiff } from '../src/evidence/ab/surface-diff.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import { LiveSurfaceDiffSchema, type RepoInfo } from '../src/evidence/types.ts';

const CORE: RepoInfo = { kind: 'civicrm-core', root: '/r', recommendedImage: 'standalone-master' };
const EXTENSION: RepoInfo = {
  kind: 'civicrm-extension',
  root: '/r',
  extensionName: 'widgets',
  recommendedImage: 'standalone',
};

function diffOf(files: Record<string, string>) {
  return parseUnifiedDiff(
    Object.entries(files)
      .map(
        ([path, added]) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,2 +1,3 @@
 context
+${added}
`,
      )
      .join(''),
  );
}

const kindsByPath = (report: ReturnType<typeof computeSurfaceDiff>) =>
  report.changes.map((c) => `${c.kind} ${c.path}`);

describe('static surface diff', () => {
  test('a change without structural surface reports nothing', () => {
    const report = computeSurfaceDiff(diffOf({ 'CRM/Utils/String.php': '// comment' }), CORE);
    expect(report.changes).toEqual([]);
    expect(report.unverifiedSurfaces).toEqual([]);
    expect(report.summary).toBe('No high-risk structural surface changes detected.');
  });

  test('classifies routes, APIv4, managed entities, templates and composer', () => {
    const report = computeSurfaceDiff(
      diffOf({
        'xml/Menu/Thing.xml': '<item/>',
        'Civi/Api4/Thing.php': '// action',
        'managed/Thing.mgd.php': '// entity',
        'templates/CRM/Thing/Page.tpl': '<p>x</p>',
        'composer.json': '"a/b": "^1"',
      }),
      EXTENSION,
    );
    expect(kindsByPath(report)).toEqual([
      'menu-route xml/Menu/Thing.xml',
      'apiv4-action Civi/Api4/Thing.php',
      'managed managed/Thing.mgd.php',
      'template templates/CRM/Thing/Page.tpl',
      'composer composer.json',
    ]);
    expect(report.unverifiedSurfaces).toEqual([
      'composer dependencies changed; composer install not executed in mounted container',
    ]);
    expect(report.touchedComponents).toEqual(['widgets']);
  });

  test('flags a touched permission check and a hook implementation', () => {
    const report = computeSurfaceDiff(
      diffOf({
        'CRM/Thing/Page.php': '  ->setCheckPermissions(FALSE)',
        'widgets.php': 'function widgets_civicrm_config(&$config) {',
      }),
      EXTENSION,
    );
    expect(kindsByPath(report)).toEqual([
      'permission-check CRM/Thing/Page.php',
      'hook widgets.php',
    ]);
  });

  test('a core change names its top-level components', () => {
    const report = computeSurfaceDiff(
      diffOf({ 'CRM/Utils/String.php': '// a', 'ext/afform/core/afform.php': '// b' }),
      CORE,
    );
    expect(report.touchedComponents).toEqual(['CRM', 'ext/afform']);
  });
});

describe('live surface diff', () => {
  const base = computeSurfaceDiff(diffOf({ 'CRM/Utils/String.php': '// a' }), CORE);

  test('a failed capture is not verified and adds no changes', () => {
    const merged = mergeLiveSurfaceDiff(base, LiveSurfaceDiffSchema.parse({ error: 'cv failed' }));
    expect(merged.unverifiedSurfaces).toEqual(['Live surface capture failed: cv failed']);
    expect(merged.changes).toEqual([]);
  });

  test('an unchanged live surface adds nothing', () => {
    const empty = { added: [], removed: [], changed: [] };
    const merged = mergeLiveSurfaceDiff(
      base,
      LiveSurfaceDiffSchema.parse({ api4: empty, routes: empty }),
    );
    expect(merged.changes).toEqual([]);
    expect(merged.unverifiedSurfaces).toEqual([]);
    expect(merged.summary).toBe(base.summary);
  });

  test('names added actions, removed routes and risk flags', () => {
    const none = { added: [], removed: [], changed: [] };
    const merged = mergeLiveSurfaceDiff(
      base,
      LiveSurfaceDiffSchema.parse({
        api4: { ...none, added: [{ entity: 'Thing', action: 'purge' }] },
        routes: { ...none, removed: [{ path: 'civicrm/thing' }] },
        afform: { ...none, changed: [{ name: 'afformThing' }] },
        risk_flags: [
          {
            code: 'PERM_REMOVED',
            severity: 'high',
            category: 'routes',
            target: 'civicrm/thing',
            reason: 'permission dropped',
          },
        ],
      }),
    );
    expect(merged.changes.map((c) => `${c.kind} ${c.change} ${c.detail}`)).toEqual([
      'apiv4-action added Live APIv4 surface added: Thing.purge',
      'menu-route removed Live Route surface removed: civicrm/thing',
      'template modified Live Afform surface changed: afformThing',
      'permission-check modified [HIGH PERM_REMOVED] permission dropped',
    ]);
    expect(merged.summary).toEndWith('Live surface diff flagged 1 risk(s).');
  });
});
