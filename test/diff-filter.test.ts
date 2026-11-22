import { describe, expect, test } from 'bun:test';
import {
  classifyFilePath,
  extractAddedTestMethods,
  filterAndTruncateDiff,
  isNoiseFile,
  matchesGlob,
  parseUnifiedDiff,
} from '../src/evidence/diff-filter.ts';

const SAMPLE_DIFF = `diff --git a/CRM/Contact/BAO/Contact.php b/CRM/Contact/BAO/Contact.php
index 1111111..2222222 100644
--- a/CRM/Contact/BAO/Contact.php
+++ b/CRM/Contact/BAO/Contact.php
@@ -10,4 +10,5 @@ class CRM_Contact_BAO_Contact {
   public static function greet($name) {
-    return "Hi " . $name;
+    $safe = htmlspecialchars($name, ENT_QUOTES);
+    return "Hi " . $safe;
   }
 }
diff --git a/composer.lock b/composer.lock
index 3333333..4444444 100644
--- a/composer.lock
+++ b/composer.lock
@@ -1,2 +1,2 @@
-"old"
+"new"
diff --git a/vendor/pkg/index.js b/vendor/pkg/index.js
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/vendor/pkg/index.js
@@ -0,0 +1 @@
+console.log(1);
diff --git a/assets/app.min.js b/assets/app.min.js
index 6666666..7777777 100644
--- a/assets/app.min.js
+++ b/assets/app.min.js
@@ -1 +1 @@
-a()
+b()
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
diff --git a/CRM/Upgrade/Incremental/php/SixZero.php b/CRM/Upgrade/Incremental/php/SixZero.php
index 8888888..9999999 100644
--- a/CRM/Upgrade/Incremental/php/SixZero.php
+++ b/CRM/Upgrade/Incremental/php/SixZero.php
@@ -1,2 +1,3 @@
 <?php
+// upgrade step
 `;

describe('diff-filter', () => {
  test('parses hunks and valid right/left line numbers accurately', () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);
    const contact = files.find(
      (f) => f.path === 'CRM/Contact/BAO/Contact.php',
    );
    expect(contact).toBeDefined();
    expect(contact?.status).toBe('modified');
    expect(contact?.additions).toBe(2);
    expect(contact?.deletions).toBe(1);
    expect(contact?.hunks.length).toBe(1);
    // Line 10 (context), 11 (removed on left), 11+12 (added on right), 13+14 (context)
    expect(contact?.validLeftLines).toEqual([10, 11, 12, 13]);
    expect(contact?.validRightLines).toEqual([10, 11, 12, 13, 14]);
  });

  test('filters lockfiles, vendor bundles, minified assets, and binaries', () => {
    expect(isNoiseFile('composer.lock')).toBe(true);
    expect(isNoiseFile('package-lock.json')).toBe(true);
    expect(isNoiseFile('vendor/foo/bar.php')).toBe(true);
    expect(isNoiseFile('node_modules/x/y.js')).toBe(true);
    expect(isNoiseFile('dist/bundle.js')).toBe(true);
    expect(isNoiseFile('js/app.min.js')).toBe(true);
    expect(isNoiseFile('CRM/Contact/BAO/Contact.php')).toBe(false);

    const filtered = filterAndTruncateDiff(SAMPLE_DIFF, 100_000);
    expect(filtered.files.map((f) => f.path)).toEqual([
      'CRM/Contact/BAO/Contact.php',
      'CRM/Upgrade/Incremental/php/SixZero.php',
    ]);
    expect(filtered.droppedNoiseFiles).toEqual([
      'composer.lock',
      'vendor/pkg/index.js',
      'assets/app.min.js',
      'logo.png',
    ]);
    expect(filtered.truncated).toBe(false);
  });

  test('classifies CiviCRM schema, upgrade, UI, composer, APIv4, and test paths', () => {
    expect(classifyFilePath('composer.json').isComposer).toBe(true);
    expect(classifyFilePath('xml/schema/CRM/Contact/Contact.xml').isSchema).toBe(true);
    expect(classifyFilePath('schema/Item.entityType.php').isSchema).toBe(true);
    expect(classifyFilePath('CRM/Upgrade/Incremental/php/SixZero.php').isUpgrade).toBe(true);
    expect(classifyFilePath('CRM/MyExt/Upgrader.php').isUpgrade).toBe(true);
    expect(classifyFilePath('managed/my_entities.mgd.php').isManaged).toBe(true);
    expect(classifyFilePath('templates/CRM/Contact/Page/View.tpl').isSmartyTemplate).toBe(true);
    expect(classifyFilePath('ang/afsearchFoo.aff.html').isAfform).toBe(true);
    expect(classifyFilePath('js/widget.js').isFrontendAsset).toBe(true);
    expect(classifyFilePath('tests/phpunit/CRM/Contact/ContactTest.php').isTest).toBe(true);
    expect(classifyFilePath('xml/Menu/myext.xml').isMenuXml).toBe(true);
    expect(classifyFilePath('Civi/Api4/Action/MyEntity/Get.php').isApiV4).toBe(true);
  });

  test('truncates oversized patch cleanly when maxBytes is exceeded', () => {
    const filtered = filterAndTruncateDiff(SAMPLE_DIFF, 300);
    expect(filtered.truncated).toBe(true);
    expect(filtered.filteredPatch).toContain('TRUNCATED');
  });

  test('supports path include/exclude glob filtering (*, **, ?)', () => {
    expect(matchesGlob('CRM/Contact/BAO/Contact.php', 'CRM/**/*.php')).toBe(true);
    expect(matchesGlob('CRM/Contact/BAO/Contact.php', 'CRM/**/Contact.ph?')).toBe(true);
    expect(matchesGlob('CRM/Upgrade/Incremental/php/SixZero.php', 'CRM/Upgrade/**')).toBe(true);
    expect(matchesGlob('CRM/Contact/BAO/Contact.php', 'CRM/Upgrade/**')).toBe(false);

    const excluded = filterAndTruncateDiff(SAMPLE_DIFF, 100_000, {
      exclude: ['CRM/Upgrade/**'],
    });
    expect(excluded.files.map((f) => f.path)).toEqual([
      'CRM/Contact/BAO/Contact.php',
    ]);
    expect(excluded.droppedNoiseFiles).toContain(
      'CRM/Upgrade/Incremental/php/SixZero.php',
    );

    const included = filterAndTruncateDiff(SAMPLE_DIFF, 100_000, {
      include: ['**/Upgrade/**/*.php'],
    });
    expect(included.files.map((f) => f.path)).toEqual([
      'CRM/Upgrade/Incremental/php/SixZero.php',
    ]);
  });

  test('extractAddedTestMethods tracks right-side line numbers and filters non-test/deleted/helper methods', () => {
    const diff = `diff --git a/CRM/Contact/BAO/Query.php b/CRM/Contact/BAO/Query.php
--- a/CRM/Contact/BAO/Query.php
+++ b/CRM/Contact/BAO/Query.php
@@ -10,2 +10,3 @@ class CRM_Contact_BAO_Query {
+  public function testNotInTestFile() {}
diff --git a/tests/phpunit/CRM/Contact/BAO/QueryTest.php b/tests/phpunit/CRM/Contact/BAO/QueryTest.php
--- a/tests/phpunit/CRM/Contact/BAO/QueryTest.php
+++ b/tests/phpunit/CRM/Contact/BAO/QueryTest.php
@@ -40,6 +40,12 @@ class CRM_Contact_BAO_QueryTest extends CiviUnitTestCase {
   protected function setUp(): void {}
-  public function testRemovedMethod(): void {}
+  public function helperDataProvider(): array {
+    return [];
+  }
+  public function testOrderByAlwaysIncludesContactId(): void {
+    $this->assertTrue(true);
+  }
+  function testPackageVisibilityTest(): void {
+    $this->assertTrue(true);
+  }
diff --git a/tests/phpunit/CRM/OldTest.php b/tests/phpunit/CRM/OldTest.php
deleted file mode 100644
--- a/tests/phpunit/CRM/OldTest.php
+++ /dev/null
@@ -1,3 +0,0 @@
-<?php
-class OldTest {}
`;

    const files = parseUnifiedDiff(diff);
    const added = extractAddedTestMethods(files);
    expect(added).toEqual([
      {
        file: 'tests/phpunit/CRM/Contact/BAO/QueryTest.php',
        method: 'testOrderByAlwaysIncludesContactId',
        line: 44,
      },
      {
        file: 'tests/phpunit/CRM/Contact/BAO/QueryTest.php',
        method: 'testPackageVisibilityTest',
        line: 47,
      },
    ]);
  });
});
