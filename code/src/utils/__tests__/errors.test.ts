/**
 * Tests for the small error-narrowing helpers used in every catch block.
 * These helpers exist so callers can keep `catch (e: unknown)` strict-mode
 * compliant without writing the narrowing inline.
 */

import { errMsg, errResponseData, errResponseStatus } from '../errors';

describe('errMsg', () => {
  it('returns the message of an Error instance', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
  });

  it('preserves an empty Error message verbatim', () => {
    // Some libs throw `new Error()` with no message — we should not invent one.
    expect(errMsg(new Error(''))).toBe('');
  });

  it('returns the value verbatim when it is a string', () => {
    expect(errMsg('plain string error')).toBe('plain string error');
  });

  it('reads .message from an error-shaped plain object', () => {
    // axios sometimes passes plain `{ message }` shapes that aren't Error instances.
    expect(errMsg({ message: 'shaped' })).toBe('shaped');
  });

  it('falls back to String() for arbitrary primitives', () => {
    expect(errMsg(42)).toBe('42');
    expect(errMsg(null)).toBe('null');
    expect(errMsg(undefined)).toBe('undefined');
    expect(errMsg(false)).toBe('false');
  });

  it('falls back to String() for objects without a .message string', () => {
    expect(errMsg({ message: 42 })).toMatch(/object/i);
    expect(errMsg({})).toMatch(/object/i);
  });

  it('subclasses of Error still report through the Error branch', () => {
    class CustomError extends Error {}
    expect(errMsg(new CustomError('subclass'))).toBe('subclass');
  });
});

describe('errResponseData', () => {
  it('returns the data field from an axios-shaped error', () => {
    const axiosLike = { response: { data: { code: 'NOT_FOUND', message: 'gone' } } };
    expect(errResponseData(axiosLike)).toEqual({ code: 'NOT_FOUND', message: 'gone' });
  });

  it('returns undefined when the value is not an object', () => {
    expect(errResponseData(null)).toBeUndefined();
    expect(errResponseData(undefined)).toBeUndefined();
    expect(errResponseData('string')).toBeUndefined();
    expect(errResponseData(42)).toBeUndefined();
  });

  it('returns undefined when there is no .response property', () => {
    expect(errResponseData(new Error('no response'))).toBeUndefined();
    expect(errResponseData({})).toBeUndefined();
  });

  it('returns undefined when .response is not an object', () => {
    expect(errResponseData({ response: 'oops' })).toBeUndefined();
    expect(errResponseData({ response: null })).toBeUndefined();
  });

  it('returns undefined data field as-is (data legitimately missing)', () => {
    expect(errResponseData({ response: {} })).toBeUndefined();
  });

  it('handles falsy data values like empty string / zero', () => {
    // The helper only narrows the shape; it does not coerce 0/''/null → undefined.
    expect(errResponseData({ response: { data: 0 } })).toBe(0);
    expect(errResponseData({ response: { data: '' } })).toBe('');
  });
});

describe('errResponseStatus', () => {
  it('returns the numeric status from an axios-shaped error', () => {
    expect(errResponseStatus({ response: { status: 404 } })).toBe(404);
    expect(errResponseStatus({ response: { status: 500 } })).toBe(500);
  });

  it('returns undefined when the value is not an object', () => {
    expect(errResponseStatus(null)).toBeUndefined();
    expect(errResponseStatus('boom')).toBeUndefined();
  });

  it('returns undefined when there is no .response property', () => {
    expect(errResponseStatus(new Error('plain'))).toBeUndefined();
  });

  it('returns undefined when .response is not an object', () => {
    expect(errResponseStatus({ response: 500 })).toBeUndefined();
  });

  it('returns undefined when status is not a number', () => {
    // Some libs surface status as a string, e.g. '404'. We require numeric.
    expect(errResponseStatus({ response: { status: '404' } })).toBeUndefined();
    expect(errResponseStatus({ response: {} })).toBeUndefined();
  });
});
