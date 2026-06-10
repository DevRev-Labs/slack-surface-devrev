/**
 * Unit tests for the error-utility helpers (src/utils/errors.ts).
 *
 * Tests cover:
 *   - errMsg: extracting a printable string from any thrown value
 *   - errResponseData: reading response.data from an axios-like error
 *   - errResponseStatus: reading response.status from an axios-like error
 */

import { errMsg, errResponseData, errResponseStatus } from '../errors';

// ──────────────────────────────────────────────────────────────────────────────
// errMsg
// ──────────────────────────────────────────────────────────────────────────────

describe('errMsg', () => {
  it('returns the message property of an Error instance', () => {
    expect(errMsg(new Error('something broke'))).toBe('something broke');
  });

  it('returns the string itself when passed a plain string', () => {
    expect(errMsg('raw string error')).toBe('raw string error');
  });

  it('returns the message field from a plain object that has a string message', () => {
    expect(errMsg({ message: 'object error' })).toBe('object error');
  });

  it('falls back to String() for numbers', () => {
    expect(errMsg(42)).toBe('42');
  });

  it('falls back to String() for null', () => {
    expect(errMsg(null)).toBe('null');
  });

  it('falls back to String() for undefined', () => {
    expect(errMsg(undefined)).toBe('undefined');
  });

  it('falls back to String() for objects without a string message field', () => {
    expect(errMsg({ message: 123 })).toBe('[object Object]');
  });

  it('falls back to String() for arrays', () => {
    expect(errMsg(['a', 'b'])).toBe('a,b');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// errResponseData
// ──────────────────────────────────────────────────────────────────────────────

describe('errResponseData', () => {
  it('returns response.data from an axios-like error object', () => {
    const axiosError = { response: { data: { message: 'Conflict' }, status: 409 } };
    expect(errResponseData(axiosError)).toEqual({ message: 'Conflict' });
  });

  it('returns undefined when the error has no response property', () => {
    expect(errResponseData(new Error('no response'))).toBeUndefined();
  });

  it('returns undefined when the response has no data property', () => {
    const err = { response: { status: 500 } };
    expect(errResponseData(err)).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(errResponseData(null)).toBeUndefined();
  });

  it('returns undefined for primitive input', () => {
    expect(errResponseData('string')).toBeUndefined();
    expect(errResponseData(0)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// errResponseStatus
// ──────────────────────────────────────────────────────────────────────────────

describe('errResponseStatus', () => {
  it('returns the numeric status from an axios-like error', () => {
    const axiosError = { response: { data: {}, status: 404 } };
    expect(errResponseStatus(axiosError)).toBe(404);
  });

  it('returns undefined when there is no response', () => {
    expect(errResponseStatus(new Error('no response'))).toBeUndefined();
  });

  it('returns undefined when status is a string (non-numeric)', () => {
    const err = { response: { status: 'bad' } };
    expect(errResponseStatus(err)).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(errResponseStatus(null)).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(errResponseStatus(undefined)).toBeUndefined();
  });
});
