import assert from 'node:assert/strict';

export class ScriptedLLMError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ScriptedLLMError';
  }
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

export class ScriptedLLM {
  constructor(expectations = []) {
    if (!Array.isArray(expectations)) throw new ScriptedLLMError('expectations must be an array');
    this.expectations = expectations.slice();
    this.index = 0;
    this.calls = [];
  }

  async complete(request) {
    const call = clone(request);
    this.calls.push(call);

    const expectation = this.expectations[this.index];
    if (!expectation) {
      throw new ScriptedLLMError(`unexpected LLM call #${this.index + 1}: no scripted expectation remains`);
    }

    this.#assertMatches(expectation, request, this.index);
    this.index += 1;

    if ('error' in expectation) {
      throw expectation.error instanceof Error
        ? expectation.error
        : new ScriptedLLMError(String(expectation.error));
    }
    if (!('output' in expectation)) {
      throw new ScriptedLLMError(`scripted expectation #${this.index} requires output or error`);
    }
    return clone(expectation.output);
  }

  remaining() {
    return this.expectations.length - this.index;
  }

  assertExhausted() {
    const remaining = this.remaining();
    if (remaining !== 0) {
      throw new ScriptedLLMError(`${remaining} scripted LLM expectation${remaining === 1 ? '' : 's'} not consumed`);
    }
  }

  #assertMatches(expectation, request, index) {
    if (typeof expectation.match === 'function') {
      let matched = false;
      try {
        matched = expectation.match(request) === true;
      } catch (error) {
        throw new ScriptedLLMError(`LLM matcher #${index + 1} threw: ${error.message}`, { cause: error });
      }
      if (!matched) {
        throw new ScriptedLLMError(`LLM request mismatch at call #${index + 1}: predicate returned false`);
      }
      return;
    }

    if (!('request' in expectation)) {
      throw new ScriptedLLMError(`scripted expectation #${index + 1} requires request or match`);
    }

    try {
      assert.deepStrictEqual(request, expectation.request);
    } catch (error) {
      throw new ScriptedLLMError(
        `LLM request mismatch at call #${index + 1}\n${error.message}`,
        { cause: error },
      );
    }
  }
}
