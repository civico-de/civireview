import { describe, expect, test } from 'bun:test';
import { parseMentionCommand } from '../src/github/commands.ts';

describe('parseMentionCommand', () => {
  test('triggers on @civireview case-insensitively and parses allowlisted flags', () => {
    const parsed = parseMentionCommand(
      '@CiviReview --full --no-ab --demo --preset cross-model --model openai:gpt-5.2 --verifier anthropic:claude-opus-4-6 Please check the ACL guard here.',
    );

    expect(parsed.triggered).toBe(true);
    expect(parsed.flags).toEqual({
      full: true,
      ab: false,
      demo: true,
      preset: 'cross-model',
      model: 'openai:gpt-5.2',
      verifier: 'anthropic:claude-opus-4-6',
    });
    expect(parsed.question).toBe('Please check the ACL guard here.');
  });

  test('ignores mentions inside fenced code blocks, inline code, blockquotes, and emails', () => {
    const fenced = [
      'Here is an example:',
      '```bash',
      '@civireview --full',
      '```',
      '> @civireview --demo',
      'And inline `@civireview --no-ab` or email user@civireview.org.',
    ].join('\n');

    const res = parseMentionCommand(fenced);
    expect(res.triggered).toBe(false);
    expect(res.flags).toEqual({});
    expect(res.question).toBe('');
  });

  test('supports --flag=value syntax and --ab flag', () => {
    const res = parseMentionCommand(
      'Hey @civireview: --ab --preset=subscription --model=claude-cli:sonnet',
    );
    expect(res.triggered).toBe(true);
    expect(res.flags).toEqual({
      ab: true,
      preset: 'subscription',
      model: 'claude-cli:sonnet',
    });
  });

  test('rejects invalid preset and invalid model specs', () => {
    expect(() =>
      parseMentionCommand('@civireview --preset nonexistent'),
    ).toThrow(/Invalid preset/);

    expect(() =>
      parseMentionCommand('@civireview --model badprovider:foo'),
    ).toThrow(/Invalid model spec/);

    expect(() =>
      parseMentionCommand('@civireview --verifier missing-colon'),
    ).toThrow(/Invalid verifier model spec/);
  });

  test('parses --include, --exclude, repeatable --page, --no-browser, --interactive-browser, and --live-prove', () => {
    const parsed = parseMentionCommand(
      '@civireview --include browser,ui --exclude=matrix --page civicrm/admin --page=civicrm/contact/view --no-browser --interactive-browser --live-prove Check layout',
    );

    expect(parsed.triggered).toBe(true);
    expect(parsed.flags).toEqual({
      include: ['browser', 'ui'],
      exclude: ['matrix'],
      pages: ['civicrm/admin', 'civicrm/contact/view'],
      browser: false,
      interactiveBrowser: true,
      liveProve: true,
    });
    expect(parsed.question).toBe('Check layout');
  });
});
