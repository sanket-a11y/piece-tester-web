import { describe, it, expect } from 'vitest';
import { firstFailedStepError, extractFirstStepError } from './queries.js';

const wrapper = JSON.stringify({
  status: 'FAILED',
  errorMessage: JSON.stringify({ __apErrorVersion: 1, message: 'Invalid Request: reaction must be a valid emoji', code: 'BAD_REQUEST', status: 400 }),
  output: null,
});
const stepResults = JSON.stringify([{ stepId: 's1', status: 'failed', error: wrapper }]);

describe('firstFailedStepError', () => {
  it('returns the raw error string of the first failed step', () => {
    expect(firstFailedStepError(stepResults)).toBe(wrapper);
  });
  it('returns null when there is no failed step', () => {
    expect(firstFailedStepError(JSON.stringify([{ stepId: 's1', status: 'completed', error: null }]))).toBeNull();
  });
});

describe('extractFirstStepError', () => {
  it('previews the real message, not the raw wrapper', () => {
    expect(extractFirstStepError(stepResults)).toBe('Invalid Request: reaction must be a valid emoji');
  });
  it('caps the preview at 100 chars', () => {
    const long = 'x'.repeat(150);
    const sr = JSON.stringify([{ status: 'failed', error: long }]);
    const out = extractFirstStepError(sr)!;
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(101);
  });
});
