import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectRepoInfo,
  getCivikitchenImageCandidates,
  selectCivikitchenImage,
} from '../src/evidence/repo-detect.ts';

const dirs: string[] = [];

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'civireview-detect-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const VERSION_XML = '<version><version_no>6.4.1</version_no></version>';
const INFO_XML = `<extension key="org.example.demo" type="module"><file>demo</file></extension>`;

describe('detectRepoInfo', () => {
  test('recognises civicrm-core by xml/version.xml plus CRM/ and picks the image from the base branch', () => {
    const root = makeRepo({ 'xml/version.xml': VERSION_XML, 'CRM/.keep': '' });

    expect(detectRepoInfo(root, 'master')).toMatchObject({
      kind: 'civicrm-core',
      civicrmVersion: '6.4.1',
      recommendedImage: 'standalone-master',
    });
    expect(detectRepoInfo(root, '6.2').recommendedImage).toBe('standalone-6.2');
    // Feature branches fall back to the version in version.xml.
    expect(detectRepoInfo(root, 'my-fix').recommendedImage).toBe('standalone-6.4');
  });

  test('does not treat a lone xml/version.xml as core', () => {
    const root = makeRepo({ 'xml/version.xml': VERSION_XML });
    expect(detectRepoInfo(root).kind).toBe('generic');
  });

  test('reads key and name from info.xml and the CiviCRM floor from civikitchen.yaml', () => {
    const root = makeRepo({
      'info.xml': INFO_XML,
      'civikitchen.yaml': 'policy:\n  civicrm: "5.81"\n',
    });

    expect(detectRepoInfo(root, 'main')).toMatchObject({
      kind: 'civicrm-extension',
      extensionKey: 'org.example.demo',
      extensionName: 'demo',
      civicrmFloor: '5.81',
      recommendedImage: 'standalone-5.81',
    });
  });

  test('keeps a trailing zero when the floor is an unquoted YAML number (6.10 is not 6.1)', () => {
    const root = makeRepo({
      'info.xml': INFO_XML,
      'civikitchen.yaml': 'policy:\n  civicrm: 6.10\n',
    });

    const info = detectRepoInfo(root);

    expect(info.civicrmFloor).toBe('6.10');
    expect(info.recommendedImage).toBe('standalone-6.10');
  });

  test('survives a malformed civikitchen.yaml and an extension without a floor', () => {
    const root = makeRepo({ 'info.xml': INFO_XML, 'civikitchen.yaml': 'policy: [unclosed\n' });

    expect(detectRepoInfo(root)).toMatchObject({
      kind: 'civicrm-extension',
      civicrmFloor: undefined,
      recommendedImage: 'standalone',
    });
  });

  test('a civikitchen.yaml alone marks an extension, anything else is generic', () => {
    expect(detectRepoInfo(makeRepo({ 'civikitchen.yaml': 'policy: {}\n' })).kind).toBe(
      'civicrm-extension',
    );
    expect(detectRepoInfo(makeRepo({ 'README.md': '# x' }))).toMatchObject({
      kind: 'generic',
      recommendedImage: 'standalone',
    });
  });
});

describe('image selection', () => {
  test('core: release branches and master map to tags, unknown inputs fall back to master', () => {
    expect(selectCivikitchenImage({ kind: 'civicrm-core', baseBranch: 'main' })).toBe(
      'standalone-master',
    );
    expect(selectCivikitchenImage({ kind: 'civicrm-core', baseBranch: '6.10' })).toBe(
      'standalone-6.10',
    );
    expect(selectCivikitchenImage({ kind: 'civicrm-core' })).toBe('standalone-master');
  });

  test('candidates start with the preferred tag and contain no duplicates', () => {
    expect(getCivikitchenImageCandidates('standalone-6.21', 'civicrm-core')).toEqual([
      'standalone-6.21',
      'standalone-beta',
      'standalone-master',
      'standalone-latest',
      'standalone',
    ]);
    expect(getCivikitchenImageCandidates('standalone', 'civicrm-extension')).toEqual([
      'standalone',
      'standalone-latest',
    ]);
  });
});
