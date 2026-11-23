import { describe, expect, test } from 'bun:test';
import { BrowserConfigSchema } from '../src/config/schema.ts';
import { discoverStandaloneRoutes } from '../src/evidence/browser-routes.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import type { SurfaceDiffReport } from '../src/evidence/types.ts';

describe('discoverStandaloneRoutes', () => {
  test('extracts routes & public/private Afforms from live surface-diff.json', () => {
    const surfaceDiff: SurfaceDiffReport = {
      changes: [],
      unverifiedSurfaces: [],
      touchedComponents: ['CRM'],
      summary: 'Live changes',
      liveSurfaceDiff: {
        routes: {
          added: [{ path: '/civicrm/custom/report' }, { path: 'civicrm/item/%' }],
          removed: [],
          changed: [{ path: 'civicrm/admin/setting/misc' }],
        },
        afform: {
          added: [
            { server_route: 'civicrm/public-form', is_public: true },
            { server_route: 'civicrm/internal-form', is_public: false },
          ],
          removed: [],
          changed: [],
        },
        risk_flags: [],
      },
    };

    const res = discoverStandaloneRoutes({
      diffFiles: [],
      surfaceDiff,
      config: { browser: BrowserConfigSchema.parse({}) },
    });

    expect(res.pages).toEqual([
      'civicrm/custom/report',
      'civicrm/admin/setting/misc',
      'civicrm/public-form',
      'civicrm/internal-form',
    ]);
    expect(res.anonymousPages).toEqual(['civicrm/public-form']);
    expect(res.reason).toContain('live surface');
  });

  test('statically parses Menu XML, Afform JSON, and PR body mentions while filtering wildcards', () => {
    const diff = parseUnifiedDiff(`diff --git a/xml/Menu/myext.xml b/xml/Menu/myext.xml
new file mode 100644
--- /dev/null
+++ b/xml/Menu/myext.xml
@@ -0,0 +1,6 @@
+<menu>
+  <item>
+    <path>civicrm/myext/overview</path>
+    <path>civicrm/myext/edit/{id}</path>
+  </item>
+</menu>
diff --git a/ang/afsearchMyExt.aff.json b/ang/afsearchMyExt.aff.json
new file mode 100644
--- /dev/null
+++ b/ang/afsearchMyExt.aff.json
@@ -0,0 +1,4 @@
+{
+  "server_route": "civicrm/myext/public-search",
+  "is_public": true
+}
`);

    const res = discoverStandaloneRoutes({
      diffFiles: diff,
      prBody: 'Test manually at civicrm/myext/settings and ignore civicrm/user/% placeholder.',
      config: { browser: BrowserConfigSchema.parse({}) },
    });

    expect(res.pages).toEqual([
      'civicrm/myext/overview',
      'civicrm/myext/public-search',
      'civicrm/myext/settings',
    ]);
    expect(res.anonymousPages).toEqual(['civicrm/myext/public-search']);
  });

  test('falls back to civicrm/dashboard?reset=1 when frontend assets changed with no explicit route', () => {
    const diff =
      parseUnifiedDiff(`diff --git a/templates/CRM/Contact/Page/View.tpl b/templates/CRM/Contact/Page/View.tpl
--- a/templates/CRM/Contact/Page/View.tpl
+++ b/templates/CRM/Contact/Page/View.tpl
@@ -1,2 +1,3 @@
 <div>
+<span class="badge">New</span>
 </div>
`);

    const res = discoverStandaloneRoutes({
      diffFiles: diff,
      config: { browser: BrowserConfigSchema.parse({}) },
    });

    expect(res.pages).toEqual(['civicrm/dashboard?reset=1']);
    expect(res.anonymousPages).toEqual([]);
    expect(res.reason).toContain('UI asset fallback');
  });

  test('caps auto-discovered pages at maxAutoPages while always preserving explicit pages', () => {
    const res = discoverStandaloneRoutes({
      diffFiles: [],
      prBody: 'Check civicrm/r1 civicrm/r2 civicrm/r3 civicrm/r4 civicrm/r5',
      config: {
        browser: BrowserConfigSchema.parse({
          pages: ['civicrm/explicit-one', 'civicrm/explicit-two'],
          maxAutoPages: 2,
        }),
      },
    });

    expect(res.pages).toEqual([
      'civicrm/explicit-one',
      'civicrm/explicit-two',
      'civicrm/r1',
      'civicrm/r2',
    ]);
  });
});
