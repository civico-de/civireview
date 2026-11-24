import { expect, test } from 'bun:test';
import type { VerifiedFinding } from '../src/engine/schemas.ts';
import { deduplicateVerifiedFindings } from '../src/engine/findings.ts';
import { hasRunEvidence, withoutUnprovenProof } from '../src/engine/verdicts.ts';
import { makeBundle } from './helpers/bundle.ts';

const finding = (over: Partial<VerifiedFinding>) =>
  ({ id: 'F1', verdict: 'PROVEN', ...over }) as VerifiedFinding;

const at = (id: string, lens: string, title = id) =>
  finding({
    id,
    title,
    lens: lens as VerifiedFinding['lens'],
    path: 'CRM/X.php',
    side: 'RIGHT',
    startLine: 10,
    endLine: 12,
    confidence: 80,
    reassessedSeverity: 'high',
  });
const ids = (fs: VerifiedFinding[]) => deduplicateVerifiedFindings(fs).map((f) => f.id);

test('PROVEN without any run becomes CONFIRMED; with a run or a live proof it stays', () => {
  const warnings: string[] = [];
  const lowered = withoutUnprovenProof([finding({})], false, (m) => warnings.push(m));
  expect(lowered.map((f) => f.verdict)).toEqual(['CONFIRMED']);
  expect(warnings).toHaveLength(1);

  expect(withoutUnprovenProof([finding({})], true)[0]!.verdict).toBe('PROVEN');
  expect(withoutUnprovenProof([finding({ liveProofOutput: 'HTTP 200' })], false)[0]!.verdict).toBe(
    'PROVEN',
  );
  expect(withoutUnprovenProof([finding({ verdict: 'REJECTED' })], false)[0]!.verdict).toBe(
    'REJECTED',
  );
});

test('overlapping findings of two lenses are one defect, of one lens they are two', () => {
  expect(ids([at('A', 'security'), at('B', 'correctness')])).toHaveLength(1);
  expect(ids([at('A', 'security'), at('B', 'security')]).toSorted()).toEqual(['A', 'B']);
  // A follow-up round reporting the defect again under the same title is one finding.
  expect(
    ids([at('A', 'security', 'SQL injection'), at('B', 'security', 'sql injection ')]),
  ).toHaveLength(1);
});

test('a run counts as evidence only when it produced a result', () => {
  const base = makeBundle();
  const withAb = (abReport: object, toolsRun: string[] = []) =>
    makeBundle({
      abReport: { ...base.abReport, checks: [], browserDiff: undefined, ...abReport } as never,
      staticDelta: { ...base.staticDelta, toolsRun },
    });
  const check = { ...base.abReport.checks[0]! };
  expect(hasRunEvidence(withAb({}))).toBe(false);
  expect(hasRunEvidence(withAb({ checks: [{ ...check, status: 'ERROR' }] }))).toBe(false);
  expect(hasRunEvidence(withAb({ browserDiff: { error: 'boom' } }))).toBe(false);
  expect(hasRunEvidence(withAb({ checks: [{ ...check, status: 'FAIL' }] }))).toBe(true);
  expect(hasRunEvidence(withAb({}, ['cklifecycle']))).toBe(true);
});
