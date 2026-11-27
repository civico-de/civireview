import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FinalReviewSchema } from '../src/engine/schemas.ts';
import { makeBundle, SAMPLE_PATCH } from './helpers/bundle.ts';

const BIN = resolve(import.meta.dir, '../bin/civireview.ts');

// Answers each model call from a canned file chosen by the output schema it was asked for.
const FAKE_CLAUDE = `#!/bin/sh
cat > /dev/null
case "$*" in
  *activeLenses*) f=triage ;;
  *verifiedFindings*) f=verifier ;;
  *checkedWithoutFindings*) f=specialist ;;
  *'"resolved"'*) f=reply ;;
  *) echo "fake claude: unknown stage" >&2; exit 9 ;;
esac
echo "$f" >> "$FAKE_DIR/calls.log"
cat "$FAKE_DIR/$f.json"
`;

const FINDING = {
  id: 'sec-sqli',
  lens: 'security',
  title: 'SQL injection via unescaped $id',
  severity: 'critical',
  path: 'CRM/Contact/BAO/Contact.php',
  startLine: 11,
  endLine: 12,
  side: 'RIGHT',
  issue: '$id is concatenated into SQL.',
  failureScenario: 'A crafted $id extracts arbitrary rows.',
  evidence: 'Line 11 concatenates $id',
  suggestedFix: 'Use a typed parameter.',
  mcpCitations: [],
};

const envelope = (output: unknown) => JSON.stringify({ type: 'result', structured_output: output });

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'civireview-e2e-'));
  const bin = join(dir, 'fake-claude');
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);

  writeFileSync(
    join(dir, 'triage.json'),
    envelope({
      prKind: 'security-sensitive',
      intent: 'bugfix',
      riskLevel: 'high',
      activeLenses: ['security'],
      summaryBullets: ['Builds the contact query in a variable'],
      recommendedAbTests: [],
    }),
  );
  writeFileSync(
    join(dir, 'specialist.json'),
    envelope({
      lens: 'security',
      summary: 'Checked SQL construction',
      findings: [FINDING],
      checkedWithoutFindings: ['Cache invalidation'],
    }),
  );
  writeFileSync(
    join(dir, 'verifier.json'),
    envelope({
      notes: 'One candidate',
      verifiedFindings: [
        {
          ...FINDING,
          verdict: 'PROVEN',
          reassessedSeverity: 'critical',
          confidence: 97,
          verificationEvidence: 'Reproduced against the diff.',
        },
      ],
      followUpLeads: [],
    }),
  );

  writeFileSync(
    join(dir, 'reply.json'),
    envelope({
      reply: 'The query is now parameterised, so the injection path is closed.',
      resolved: true,
      references: ['CRM/Contact/BAO/Contact.php:11'],
    }),
  );

  const evidence = join(dir, 'evidence');
  mkdirSync(evidence);
  writeFileSync(
    join(evidence, 'evidence.json'),
    JSON.stringify(
      makeBundle({
        comments: [
          {
            id: 100,
            author: 'civireview-bot',
            kind: 'review_comment',
            body: 'SQL injection via unescaped $id',
            path: 'CRM/Contact/BAO/Contact.php',
            line: 11,
            createdAt: '2026-11-20T10:00:00Z',
          },
          {
            id: 101,
            author: 'contributor',
            kind: 'review_comment',
            body: 'Is this still a problem after my last push?',
            path: 'CRM/Contact/BAO/Contact.php',
            line: 11,
            inReplyToId: 100,
            createdAt: '2026-11-21T10:00:00Z',
          },
        ],
      }),
    ),
  );
  writeFileSync(join(evidence, 'diff.patch'), SAMPLE_PATCH);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function civireview(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    cwd: dir,
    env: {
      ...process.env,
      CLAUDE_BIN: join(dir, 'fake-claude'),
      FAKE_DIR: dir,
      // Keep the run offline and independent of the developer's credentials.
      GITHUB_TOKEN: '',
      GH_TOKEN: '',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('civireview CLI end to end', () => {
  test('help lists every subcommand and exits 0', async () => {
    const res = await civireview(['--help']);
    expect(res.exitCode).toBe(0);
    for (const sub of [
      'pr',
      'local',
      'evidence',
      'review',
      'publish',
      'reply',
      'parse-command',
      'watch',
    ]) {
      expect(res.stdout).toContain(`civireview ${sub}`);
    }
  });

  test('parse-command reads flags and question from the environment', async () => {
    const res = await civireview(['parse-command', '--body-env', 'BODY'], {
      BODY: '@civireview --full --preset subscription please look at this',
    });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      triggered: true,
      flags: { full: true, preset: 'subscription' },
      question: 'please look at this',
    });
  });

  test('parse-command does not trigger without the mention', async () => {
    const res = await civireview(['parse-command', '--body-env', 'BODY'], {
      BODY: 'LGTM, --full is not a command here',
    });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).triggered).toBe(false);
  });

  test('review then publish --dry-run turns a saved evidence bundle into a posted-ready review', async () => {
    const out = join(dir, 'out', 'review.json');
    const review = await civireview([
      'review',
      '--evidence',
      join(dir, 'evidence'),
      '--out',
      out,
      '--preset',
      'subscription',
    ]);
    expect(review.stderr).toContain('Review written to');
    expect(review.exitCode).toBe(0);

    const parsed = FinalReviewSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
    expect(parsed.verdict).toBe('ISSUES_FOUND');
    expect(parsed.findings.map((f) => f.id)).toEqual(['sec-sqli']);
    expect(parsed.modelsUsed).toMatchObject({ verifier: 'claude-cli:claude-opus-5-5' });
    expect(readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')).toEqual([
      'triage',
      'specialist',
      'verifier',
    ]);

    const publish = await civireview([
      'publish',
      '--review',
      out,
      '--evidence',
      join(dir, 'evidence'),
      '--dry-run',
    ]);
    expect(publish.exitCode).toBe(0);
    expect(publish.stdout).toContain('SQL injection via unescaped $id');
    expect(publish.stdout).toMatch(/<!-- civireview:v1 head_sha=2{40} base_sha=1{40} /);
    expect(publish.stderr).toContain('[dry-run] Would post 1 inline comment(s).');
  });

  test('a failing model call makes review exit non-zero and writes no review file', async () => {
    rmSync(join(dir, 'triage.json'));
    const out = join(dir, 'out', 'review.json');

    const res = await civireview([
      'review',
      '--evidence',
      join(dir, 'evidence'),
      '--out',
      out,
      '--preset',
      'subscription',
    ]);

    expect(res.exitCode).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  test('missing required options fail with a usage message', async () => {
    const review = await civireview(['review']);
    expect(review.exitCode).not.toBe(0);
    expect(review.stderr).toContain(
      'civireview review requires --evidence <dir> --out <review.json>',
    );

    const evidence = await civireview([
      'evidence',
      '--repo',
      'not-a-slug',
      '--pr',
      '1',
      '--out',
      dir,
    ]);
    expect(evidence.exitCode).not.toBe(0);
    expect(evidence.stderr).toContain('Invalid repository slug');

    const publish = await civireview(['publish', '--evidence', join(dir, 'evidence')]);
    expect(publish.exitCode).not.toBe(0);
    expect(publish.stderr).toContain('civireview publish requires --review');
  });
});

function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(
    ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', ...args],
    { cwd },
  );
  if (res.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

describe('civireview local end to end', () => {
  test('reviews the branch diff of a real repository and prints the report with inline findings', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'CRM/Contact/BAO'), { recursive: true });
    const file = join(repo, 'CRM/Contact/BAO/Contact.php');
    const before = SAMPLE_PATCH.split('\n')
      .filter((l) => l.startsWith(' ') || l.startsWith('-'))
      .map((l) => l.slice(1))
      .filter((l) => !l.startsWith('--'));
    // Eight filler lines put the changed return statement on line 11, where the canned finding points.
    const filler = Array.from({ length: 8 }, (_, i) => `// filler ${i + 1}`);
    writeFileSync(file, `<?php\n${filler.join('\n')}\n${before.join('\n')}\n`);
    git(repo, 'init', '-q', '-b', 'master');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'fix-lookup');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        /return CRM_Core_DAO::executeQuery\("SELECT \* FROM civicrm_contact WHERE id = " \. \$id\);/,
        '$sql = "SELECT * FROM civicrm_contact WHERE id = " . $id;\n    return CRM_Core_DAO::executeQuery($sql);',
      ),
    );
    git(repo, 'commit', '-q', '-am', 'build query in a variable');

    const res = await civireview([
      'local',
      '--cwd',
      repo,
      '--base',
      'master',
      '--preset',
      'subscription',
      '--no-ab',
      '--no-browser',
    ]);

    expect(res.stderr).not.toContain('Error');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('SQL injection via unescaped $id');
    expect(res.stdout).toContain('### Inline Findings');
    expect(res.stdout).toContain('CRM/Contact/BAO/Contact.php');
  });

  test('refuses to review when the base ref does not exist', async () => {
    const repo = join(dir, 'repo2');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'master');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');

    const res = await civireview([
      'local',
      '--cwd',
      repo,
      '--base',
      'no-such-ref',
      '--preset',
      'subscription',
    ]);

    expect(res.exitCode).not.toBe(0);
  });
});

describe('civireview reply end to end', () => {
  test('answers a review thread, saves the reply with its dedup marker and publishes it as a dry run', async () => {
    const evidence = join(dir, 'evidence');
    const out = join(dir, 'out', 'reply.json');

    const reply = await civireview([
      'reply',
      '--evidence',
      evidence,
      '--comment-id',
      '101',
      '--question',
      'Is this still a problem?',
      '--out',
      out,
      '--preset',
      'subscription',
      '--dry-run',
    ]);

    expect(reply.exitCode).toBe(0);
    expect(reply.stdout).toContain('The query is now parameterised');
    expect(reply.stdout).toContain('✅ Resolved');
    expect(reply.stdout).toContain('<!-- civireview:reply trigger_comment=101 -->');
    expect(readFileSync(join(dir, 'calls.log'), 'utf8').trim()).toBe('reply');

    const saved = JSON.parse(readFileSync(out, 'utf8')) as { resolved: boolean; body: string };
    expect(saved.resolved).toBe(true);

    const publish = await civireview([
      'publish',
      '--evidence',
      evidence,
      '--reply',
      out,
      '--comment-id',
      '101',
      '--dry-run',
    ]);
    expect(publish.exitCode).toBe(0);
    expect(publish.stdout).toBe(`${saved.body}\n`);
  });

  test('rejects a non-numeric comment id', async () => {
    const res = await civireview([
      'reply',
      '--evidence',
      join(dir, 'evidence'),
      '--comment-id',
      'abc',
      '--dry-run',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('Invalid --comment-id');
  });

  test('publish --reply without a comment id fails before posting anything', async () => {
    const out = join(dir, 'out', 'reply.json');
    mkdirSync(join(dir, 'out'));
    writeFileSync(out, JSON.stringify({ reply: 'x', resolved: false, references: [] }));

    const res = await civireview([
      'publish',
      '--evidence',
      join(dir, 'evidence'),
      '--reply',
      out,
      '--dry-run',
    ]);

    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('requires --comment-id');
  });
});
