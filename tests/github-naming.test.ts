import { describe, expect, it } from 'vitest';
import { conventionalCommitMessage, conventionalTitle, promotionCommitMessage, resultBranchName } from '../src/github-naming.js';

describe('generated GitHub and Git names', () => {
  it('uses conventional type prefixes and keeps conventional scopes', () => {
    expect(conventionalTitle('fix(auth): refresh fails')).toBe('fix(auth): refresh fails');
    expect(conventionalTitle('Improve GitHub integration', 'Add support for squashed merges')).toBe('feat: Improve GitHub integration');
  });

  it('uses stable conventional result branches and commit messages without run branding', () => {
    expect(resultBranchName('Fix refresh action', 'Correct GitHub refresh errors', 'run_12345678-aaaa')).toBe('fix/fix-refresh-action-5678aaaa');
    expect(conventionalCommitMessage('Add dependency support', 'Support squash merges')).toBe('feat: add dependency support');
    expect(conventionalTitle('Foreman result run_12345678')).toBe('chore: update project');
  });

  it('pins a new intent message and preserves old in-flight retry messages after task edits',()=>{
    const first=promotionCommitMessage(undefined,'Add dependency support','Support dependency relationships','run_123');
    expect(first).toBe('feat: add dependency support');
    expect(promotionCommitMessage({operationId:'stable',commitMessage:first},'Rename task','Changed goal','run_123')).toBe(first);
    expect(promotionCommitMessage({operationId:'legacy'},'Rename task','Changed goal','run_123')).toBe('Foreman approved result run_123');
  });
});
