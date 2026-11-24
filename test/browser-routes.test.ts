import { describe, expect, test } from 'bun:test';
import { BrowserConfigSchema } from '../src/config/schema.ts';
import { discoverStandaloneRoutes } from '../src/evidence/browser-routes.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import type { SurfaceDiffReport } from '../src/evidence/types.ts';

const editorDiff = () =>
  parseUnifiedDiff(`diff --git a/ext/widgets/ang/widgetEditor.aff.html b/ext/widgets/ang/widgetEditor.aff.html
--- a/ext/widgets/ang/widgetEditor.aff.html
+++ b/ext/widgets/ang/widgetEditor.aff.html
@@ -1,2 +1,3 @@
 <div>
+<select id="mode"></select>
 </div>
`);

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

  test('probes the routes of an extension whose UI changed, not the dashboard', () => {
    const res = discoverStandaloneRoutes({
      diffFiles: editorDiff(),
      extensionRouteSources: [
        {
          repoPrefix: 'ext/widgets/',
          files: [
            {
              path: 'ang/widgetAdmin.aff.php',
              content: "<?php return ['server_route' => 'civicrm/admin/widgets'];",
            },
            {
              path: 'xml/Menu/widgets.xml',
              content:
                '<menu><item><path>civicrm/widgets/item/%</path></item><item><path>civicrm/widgets/return</path></item></menu>',
            },
          ],
        },
      ],
      config: { browser: BrowserConfigSchema.parse({}) },
    });

    expect(res.pages).toEqual(['civicrm/admin/widgets', 'civicrm/widgets/return']);
    expect(res.usedFallback).toBe(false);
    expect(res.reason).toContain('extension routes (2)');
  });

  test('a public form of the extension is probed anonymously as well, a private one is not', () => {
    const res = discoverStandaloneRoutes({
      diffFiles: editorDiff(),
      extensionRouteSources: [
        {
          repoPrefix: 'ext/widgets/',
          files: [
            {
              path: 'ang/widgetPublic.aff.json',
              content: '{"server_route": "civicrm/widgets/signup", "is_public": true}',
            },
            {
              path: 'ang/widgetAdmin.aff.php',
              content:
                "<?php return ['server_route' => 'civicrm/admin/widgets', 'is_public' => FALSE];",
            },
          ],
        },
      ],
      config: { browser: BrowserConfigSchema.parse({}) },
    });
    expect(res.pages).toEqual(['civicrm/widgets/signup', 'civicrm/admin/widgets']);
    expect(res.anonymousPages).toEqual(['civicrm/widgets/signup']);
  });

  test('leaves the routes of an extension alone when the diff touches no UI file of it', () => {
    const diff =
      parseUnifiedDiff(`diff --git a/ext/widgets/CRM/Widgets/BAO/Widget.php b/ext/widgets/CRM/Widgets/BAO/Widget.php
--- a/ext/widgets/CRM/Widgets/BAO/Widget.php
+++ b/ext/widgets/CRM/Widgets/BAO/Widget.php
@@ -1,2 +1,3 @@
 <?php
+// change
`);
    const res = discoverStandaloneRoutes({
      diffFiles: diff,
      extensionRouteSources: [
        {
          repoPrefix: 'ext/widgets/',
          files: [{ path: 'xml/Menu/widgets.xml', content: '<path>civicrm/widgets/list</path>' }],
        },
      ],
      config: { browser: BrowserConfigSchema.parse({}) },
    });
    expect(res.pages).toEqual([]);
  });

  test('flags the dashboard fallback so it is not reported as a verified UI probe', () => {
    const res = discoverStandaloneRoutes({
      diffFiles: editorDiff(),
      extensionRouteSources: [{ repoPrefix: 'ext/widgets/', files: [] }],
      config: { browser: BrowserConfigSchema.parse({}) },
    });
    expect(res.pages).toEqual(['civicrm/dashboard?reset=1']);
    expect(res.usedFallback).toBe(true);
  });
});
