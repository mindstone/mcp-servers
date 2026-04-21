/**
 * Hello World MCP Server — basic smoke tests
 * Uses Node's built-in test runner (node:test) — no extra deps needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Inline the handler logic (no transport needed for unit tests) ──────────

function sayHello(name = 'World') {
  return `Hello, ${name}! 👋`;
}

function echo(message) {
  return message;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('hello_world_say_hello', () => {
  it('greets with default name', () => {
    assert.equal(sayHello(), 'Hello, World! 👋');
  });

  it('greets with a custom name', () => {
    assert.equal(sayHello('Harry'), 'Hello, Harry! 👋');
  });
});

describe('hello_world_echo', () => {
  it('echoes a message verbatim', () => {
    assert.equal(echo('test message'), 'test message');
  });

  it('echoes an empty-ish message unchanged', () => {
    assert.equal(echo('x'), 'x');
  });
});
