import { describe, expect, test } from 'bun:test';
import { mapFindingsToDiff } from '../src/engine/line-mapper.ts';
import type { VerifiedFinding } from '../src/engine/schemas.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';

const DIFF_TEXT = `diff --git a/CRM/Contact/BAO/Contact.php b/CRM/Contact/BAO/Contact.php
index 1111111..2222222 100644
--- a/CRM/Contact/BAO/Contact.php
+++ b/CRM/Contact/BAO/Contact.php
@@ -10,5 +10,6 @@ class CRM_Contact_BAO_Contact {
   public static function greet($name) {
-    return "Hi " . $name;
+    $safe = htmlspecialchars($name, ENT_QUOTES);
+    return "Hi " . $safe;
   }
 }
@@ -50,3 +51,4 @@ class CRM_Contact_BAO_Contact {
   public static function tail() {
+    return true;
   }
 }
`;

function makeFinding(overrides: Partial<VerifiedFinding> = {}): VerifiedFinding {
  return {
    id: 'f-1',
    lens: 'security',
    title: 'Sample finding',
    severity: 'high',
    reassessedSeverity: 'high',
    verdict: 'CONFIRMED',
    confidence: 92,
    path: 'CRM/Contact/BAO/Contact.php',
    startLine: 12,
    endLine: 12,
    side: 'RIGHT',
    issue: 'Unescaped output',
    failureScenario: 'XSS when rendering $name',
    evidence: 'Line 12 in Contact.php',
    verificationEvidence: 'Verified against diff and read_file',
    suggestedFix: 'Escape $name with htmlspecialchars',
    mcpCitations: ['civicrm_read:CRM/Contact/BAO/Contact.php'],
    ...overrides,
  };
}

const base = (over: Partial<VerifiedFinding>) =>
  makeFinding({ path: 'a.php', suggestionCode: 'replacement();', ...over });

describe('line-mapper', () => {
  const diffFiles = parseUnifiedDiff(DIFF_TEXT);

  test('maps valid hunk single-line and multi-line findings with suggestion block', () => {
    const fSingle = makeFinding({
      id: 'single',
      startLine: 12,
      endLine: 12,
      suggestionCode: '$safe = htmlspecialchars($name, ENT_QUOTES, "UTF-8");',
    });

    const fMulti = makeFinding({
      id: 'multi',
      startLine: 12,
      endLine: 13,
      suggestionCode:
        '$safe = htmlspecialchars($name, ENT_QUOTES, "UTF-8");\nreturn "Hi " . $safe;',
    });

    const mapped = mapFindingsToDiff([fSingle, fMulti], diffFiles);
    expect(mapped.summaryOnlyFindings).toHaveLength(0);
    expect(mapped.inlineFindings).toHaveLength(2);

    const single = mapped.inlineFindings[0]!;
    expect(single.line).toBe(12);
    expect(single.startLine).toBeUndefined();
    expect(single.snapped).toBe(false);
    expect(single.suggestionBlock).toContain('```suggestion');
    expect(single.suggestionBlock).toContain('ENT_QUOTES');

    const multi = mapped.inlineFindings[1]!;
    expect(multi.startLine).toBe(12);
    expect(multi.line).toBe(13);
    expect(multi.suggestionBlock).toContain('```suggestion');
    expect(multi.suggestionBlock).toContain('return "Hi "');
  });

  test('snaps finding within +/-2 lines of a valid hunk line', () => {
    // Line 52 is valid in second hunk (51, 52, 53, 54); line 56 is +2 from 54
    const fNear = makeFinding({
      id: 'near',
      startLine: 56,
      endLine: 56,
    });
    const mapped = mapFindingsToDiff([fNear], diffFiles);
    expect(mapped.summaryOnlyFindings).toHaveLength(0);
    expect(mapped.inlineFindings).toHaveLength(1);
    expect(mapped.inlineFindings[0]!.line).toBe(54);
    expect(mapped.inlineFindings[0]!.snapped).toBe(true);
  });

  test('demotes out-of-hunk lines and untouched files to summaryOnlyFindings without dropping', () => {
    const outOfHunk = makeFinding({
      id: 'out-hunk',
      startLine: 30,
      endLine: 30,
    });
    const untouchedFile = makeFinding({
      id: 'untouched',
      path: 'CRM/Core/BAO/Caller.php',
      startLine: 100,
      endLine: 105,
    });
    const crossHunk = makeFinding({
      id: 'cross-hunk',
      startLine: 12,
      endLine: 52,
    });

    const mapped = mapFindingsToDiff([outOfHunk, untouchedFile, crossHunk], diffFiles);
    // outOfHunk and untouchedFile demoted; crossHunk has exact endLine 52 so collapses safely to line 52 without suggestion
    expect(mapped.summaryOnlyFindings.map((f) => f.id)).toEqual(['out-hunk', 'untouched']);
    expect(mapped.inlineFindings).toHaveLength(1);
    expect(mapped.inlineFindings[0]!.line).toBe(52);
    expect(mapped.inlineFindings[0]!.suggestionBlock).toBeUndefined();
  });

  test('suppresses >15-line suggestionCode and LEFT-side suggestions', () => {
    const longSuggestion = Array.from({ length: 16 }, (_, i) => `// line ${i}`).join('\n');
    const fLong = makeFinding({
      id: 'long-sug',
      startLine: 12,
      endLine: 13,
      suggestionCode: longSuggestion,
    });
    const fLeft = makeFinding({
      id: 'left-sug',
      startLine: 11,
      endLine: 11,
      side: 'LEFT',
      suggestionCode: 'return "Hi " . $name;',
    });

    const mapped = mapFindingsToDiff([fLong, fLeft], diffFiles);
    expect(mapped.inlineFindings).toHaveLength(2);
    expect(mapped.inlineFindings[0]!.suggestionBlock).toBeUndefined();
    expect(mapped.inlineFindings[1]!.suggestionBlock).toBeUndefined();
  });

  describe('suggestions on moved lines', () => {
    const SNAP_DIFF = `diff --git a/a.php b/a.php
index 1..2 100644
--- a/a.php
+++ b/a.php
@@ -10,5 +10,6 @@ x
   ctx
-    old
+    new1
+    new2
   ctx
 }
`;
    const files = parseUnifiedDiff(SNAP_DIFF);

    test('keeps the suggestion when the lines are used unchanged', () => {
      const [m] = mapFindingsToDiff([base({ startLine: 12, endLine: 12 })], files).inlineFindings;
      expect(m!.snapped).toBe(false);
      expect(m!.suggestionBlock).toContain('replacement();');
    });

    test('drops the suggestion when the line was snapped to another line', () => {
      const [m] = mapFindingsToDiff([base({ startLine: 9, endLine: 9 })], files).inlineFindings;
      expect(m!.line).toBe(10);
      expect(m!.snapped).toBe(true);
      expect(m!.suggestionBlock).toBeUndefined();
    });

    test('drops the suggestion when a range was shortened', () => {
      const [m] = mapFindingsToDiff([base({ startLine: 8, endLine: 12 })], files).inlineFindings;
      expect(m!.startLine).toBe(10);
      expect(m!.suggestionBlock).toBeUndefined();
    });

    test('drops the suggestion when a two-line range collapses to its last line', () => {
      const [m] = mapFindingsToDiff([base({ startLine: 9, endLine: 10 })], files).inlineFindings;
      expect(m!.line).toBe(10);
      expect(m!.startLine).toBeUndefined();
      expect(m!.suggestionBlock).toBeUndefined();
    });
  });
});
