import { describe, expect, it } from 'vitest';
import { extractFallbackName } from '../sessionNaming';

describe('extractFallbackName', () => {
  it('returns up to 4 title-cased words, stripping stop words', () => {
    expect(extractFallbackName('add a sidebar navigation component for the dashboard')).toBe(
      'Add Sidebar Navigation Component',
    );
  });

  it('strips common stop words', () => {
    expect(extractFallbackName('build an authentication flow for the app')).toBe(
      'Build Authentication Flow App',
    );
  });

  it('respects maxWords param — used by app-planner (max 2)', () => {
    expect(extractFallbackName('fix the login bug in the auth service', 2)).toBe('Fix Login');
  });

  it('returns "New Session" when query is blank', () => {
    expect(extractFallbackName('')).toBe('New Session');
  });

  it('returns "New Session" when all words are stop words', () => {
    expect(extractFallbackName('a an the is are')).toBe('New Session');
  });

  it('handles a query shorter than maxWords', () => {
    expect(extractFallbackName('refactor auth')).toBe('Refactor Auth');
  });

  it('handles extra whitespace and punctuation', () => {
    expect(extractFallbackName('  build!!  a  chatbox??? ')).toBe('Build Chatbox');
  });
});
