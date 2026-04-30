import { describe, it, expect } from 'vitest';
import { AuthDiagnostics, type ScopeReport } from '../../src/auth/AuthDiagnostics.js';

describe('AuthDiagnostics.renderReport', () => {
  it('renders all_good with green checks', () => {
    const report: ScopeReport = {
      hostname: 'github.com',
      user: 'tester',
      probes: [
        { name: 'user', endpoint: 'https://api.github.com/user', status: 'ok', httpStatus: 200 },
      ],
      summary: 'all_good',
    };
    const md = AuthDiagnostics.renderReport(report);
    expect(md).toMatch(/✓.*\*\*user\*\*/);
    expect(md).toMatch(/All scopes reachable/);
  });

  it('flags forbidden scope with remediation', () => {
    const report: ScopeReport = {
      hostname: 'github.com',
      user: 'tester',
      probes: [
        { name: 'user', endpoint: 'x', status: 'ok', httpStatus: 200 },
        { name: 'org:acme', endpoint: 'x', status: 'forbidden', httpStatus: 403,
          detail: 'Token lacks the required scope.' },
      ],
      summary: 'partial',
    };
    const md = AuthDiagnostics.renderReport(report);
    expect(md).toMatch(/🚫.*org:acme/);
    expect(md).toMatch(/Token lacks/);
    expect(md).toMatch(/some scopes unreachable/i);
  });

  it('explicitly distinguishes 404 and 429', () => {
    const report: ScopeReport = {
      hostname: 'github.com',
      probes: [
        { name: 'a', endpoint: 'x', status: 'not_found', httpStatus: 404 },
        { name: 'b', endpoint: 'x', status: 'rate_limited', httpStatus: 429 },
      ],
      summary: 'partial',
    };
    const md = AuthDiagnostics.renderReport(report);
    expect(md).toMatch(/❓.*a.*HTTP 404/);
    expect(md).toMatch(/⏳.*b.*HTTP 429/);
  });

  it('flags the unauthenticated state distinctly', () => {
    const report: ScopeReport = {
      hostname: 'github.com',
      probes: [{ name: 'session', endpoint: 'x', status: 'unauthenticated', detail: 'no session' }],
      summary: 'unauthenticated',
    };
    const md = AuthDiagnostics.renderReport(report);
    expect(md).toMatch(/Not authenticated/i);
    expect(md).toMatch(/Sign in to GitHub/i);
  });
});
