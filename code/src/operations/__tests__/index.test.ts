/**
 * Unit tests for OperationFactory (src/operations/index.ts).
 *
 * Tests cover:
 *   - getOperation returns a constructed instance for a registered slug.
 *   - getOperation throws for an unknown slug.
 *   - Constructor works with an empty (default) operation map.
 */

import { OperationFactory } from '../index';

// Minimal FunctionInput stub — only the fields OperationFactory touches at runtime.
const stubEvent = {} as any;

// Minimal class that satisfies what OperationFactory's map accepts.
class MockOperation {
  constructor(public readonly event: any) {}
}

describe('OperationFactory', () => {
  it('returns an instance of the registered operation class', () => {
    const factory = new OperationFactory({ 'my-op': MockOperation as any });
    const op = factory.getOperation('my-op', stubEvent);
    expect(op).toBeInstanceOf(MockOperation);
  });

  it('throws when the slug is not registered', () => {
    const factory = new OperationFactory({});
    expect(() => factory.getOperation('unknown-op', stubEvent)).toThrow('unknown-op');
  });

  it('creates with an empty operationMap when no argument is given', () => {
    const factory = new OperationFactory();
    expect(factory.operationMap).toEqual({});
  });

  it('throws for any unregistered slug regardless of the registered map', () => {
    const factory = new OperationFactory({ 'other-op': MockOperation as any });
    expect(() => factory.getOperation('not-this-one', stubEvent)).toThrow('not-this-one');
  });
});
