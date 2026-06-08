/**
 * Tiny error utilities used across the snap-in to keep `catch` blocks
 * type-safe (`unknown` rather than `any`) without forcing every caller
 * to write the narrowing logic inline.
 */

/** Extract a printable string from a `catch (e: unknown)` value. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}

/**
 * Read `error.response.data` from an axios-like rejection without `any`.
 * Returns `undefined` if not present or not an axios error.
 */
export function errResponseData(e: unknown): unknown {
  if (!e || typeof e !== 'object') return undefined;
  const response = (e as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return undefined;
  return (response as { data?: unknown }).data;
}

/**
 * Read `error.response.status` from an axios-like rejection without `any`.
 */
export function errResponseStatus(e: unknown): number | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const response = (e as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return undefined;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}
