import { expect, it } from 'vitest';
import { DiagnosticError, runtimeDiagnostic, httpStatusFor, redactForWire } from '../src/index.js';

it('preserves safe port failure facts without serializing the internal cause', () => {
  const error = new DiagnosticError(runtimeDiagnostic({
    code: 'RESOURCE_EXHAUSTED', severity: 'error', path: 'storage/create',
    message: 'Storage capacity reached.',
    failure: { outcome: 'not-applied', retry: 'after-change', resource: 'database' },
  }), { cause: new Error('provider-secret') });
  expect(httpStatusFor(error.diagnostic)).toBe(507);
  const wire = redactForWire(error.diagnostic);
  expect(wire.failure).toEqual({ outcome: 'not-applied', retry: 'after-change', resource: 'database' });
  expect(JSON.stringify(wire)).not.toContain('provider-secret');
  expect(error.cause).toBeInstanceOf(Error);
});
