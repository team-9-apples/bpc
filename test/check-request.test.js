import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateVat } from '../src/check-request.js';

test('a valid Austrian VAT number is accepted', () => {
  assert.deepEqual(validateVat('ATU12345678'), { ok: true, vat: 'ATU12345678' });
});

//  - 'atu 1234 5678' is accepted and cleaned to 'ATU12345678'
test('spaces and lowercase cleaned up', () => {
  assert.deepEqual(validateVat('atu 1234 5678'), { ok: true, vat: 'ATU12345678' });
});

//  - 'ATU1234567' (one digit short) gives { ok: false, error: 'INVALID_VAT' }
test('one digit short produces an error', () => {
  assert.deepEqual(validateVat('ATU1234567'), { ok: false, error: 'INVALID_VAT' });
});

//  - '' and 12345 (a number, not text) are rejected
test('numbers and no text, are rejected', () => {
  assert.deepEqual(validateVat(''), { ok: false, error: 'INVALID_VAT' });
  assert.deepEqual(validateVat(12345), { ok: false, error: 'INVALID_VAT' });
});