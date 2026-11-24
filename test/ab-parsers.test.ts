import { expect, test } from 'bun:test';
import {
  buildAbCheckFromJson,
  buildAbCheckFromStdout,
  parseCkAbJsonReport,
  parseDemoErrors,
} from '../src/evidence/ab/parsers.ts';

test('a report without any test is no result, not a pass', () => {
  const check = buildAbCheckFromJson({
    name: 'base-test-regression',
    args: ['ck', 'ab'],
    imageA: 'a',
    imageB: 'b',
    res: { exitCode: 0, stdout: '', stderr: '' },
    parsedJson: parseCkAbJsonReport('{}'),
    hasProductionCodeChange: true,
    addedTestMethods: [],
  });
  expect(check.status).toBe('ERROR');
  expect(check.summary).toBe('the report of the run lists no test');
});

test('a run where only the PR side wrote results is not a proof', () => {
  const check = buildAbCheckFromStdout({
    name: 'proof-of-fix',
    args: ['ck', 'ab'],
    imageA: 'a',
    imageB: 'b',
    res: {
      exitCode: 2,
      stdout: '',
      stderr: 'ck ab: only B wrote /tmp/ck-ab.xml; the other side stopped before its tests ran',
    },
    addedTestMethods: [],
  });
  expect(check.status).toBe('ERROR');
  expect(check.summary).toContain('not compared');
});

test('demo errors count only when the PR adds them', () => {
  const out = [
    'ck demo: recording Standalone before',
    'ck demo: Standalone before: 1 script errors',
    '  TypeError: old is undefined',
    'ck demo: recording Standalone after',
    'ck demo: Standalone after: 2 script errors',
    '  TypeError: old is undefined',
    '  ReferenceError: added is not defined',
    'ck demo: /out/index.html',
  ].join('\n');
  expect(parseDemoErrors(out)).toEqual(['ReferenceError: added is not defined']);
  expect(parseDemoErrors('ck demo: /out/index.html\n')).toEqual([]);
});
