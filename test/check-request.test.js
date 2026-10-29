import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateFn, validateVat } from '../src/check-request.js';

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

//  - 'DE123456789' is accepted.
test('Deutschland is accepted', () => {
  assert.deepEqual(validateVat('DE123456789'), { ok: true, vat: 'DE123456789' });
});

//  - 'XX123456789' is rejected (unknown country).
test('unknown country is rejected', () => {
  assert.deepEqual(validateVat('XX123456789'), { ok: false, error: 'INVALID_VAT' });
});

//  - 'DE12345678' is rejected (one digit short for Germany).
test('DE VAT number too short', () => {
  assert.deepEqual(validateVat('DE12345678'), { ok: false, error: 'INVALID_VAT' });
});

test('no FN entered is fine', () => {
  assert.deepEqual(validateFn(undefined), { ok: true, fn: null });
  assert.deepEqual(validateFn(''), { ok: true, fn: null });
});

test('a valid FN is accepted', () => {
  assert.deepEqual(validateFn('123456a'), { ok: true, fn: '123456a' });
});

test('an FN with spaces and uppercase is cleaned up', () => {
  assert.deepEqual(validateFn('123456 A'), { ok: true, fn: '123456a' });
});

test('an FN without the check letter is rejected', () => {
  assert.deepEqual(validateFn('12345'), { ok: false, error: 'INVALID_FN' });
});

test('an FN that is not digits plus a letter is rejected', () => {
  assert.deepEqual(validateFn('abc'), { ok: false, error: 'INVALID_FN' });
});