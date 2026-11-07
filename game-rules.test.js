'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeWord, validateWord } = require('../src/game-rules');

const words = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'words.json'), 'utf8'));
const dictionary = new Set(words.map(normalizeWord));

test('normalizes composed Hangul and whitespace', () => {
  assert.equal(normalizeWord(' 사 과 '), '사과');
});

test('accepts a registered first word', () => {
  const result = validateWord('사과', dictionary, new Set(), '');
  assert.equal(result.ok, true);
  assert.equal(result.word, '사과');
});

test('accepts an exact last-syllable chain', () => {
  const result = validateWord('과자', dictionary, new Set(['사과']), '과');
  assert.equal(result.ok, true);
});

test('rejects a word that does not start with the required syllable', () => {
  const result = validateWord('바다', dictionary, new Set(), '과');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHAIN');
});

test('rejects repeated words', () => {
  const result = validateWord('사과', dictionary, new Set(['사과']), '');
  assert.equal(result.code, 'DUPLICATE');
});

test('rejects words outside the starter dictionary', () => {
  const result = validateWord('초전도체', dictionary, new Set(), '');
  assert.equal(result.code, 'UNKNOWN');
});

test('rejects non-Hangul and invalid length', () => {
  assert.equal(validateWord('hello', dictionary, new Set()).code, 'FORMAT');
  assert.equal(validateWord('차', dictionary, new Set()).code, 'FORMAT');
  assert.equal(validateWord('가나다라마바사아자차카타파하', dictionary, new Set()).code, 'FORMAT');
});

test('starter dictionary has no duplicate entries', () => {
  assert.equal(words.length, dictionary.size);
});


test('every starter dictionary entry is a supported Hangul word', () => {
  assert.ok(words.every(word => /^[가-힣]{2,12}$/u.test(word)));
});
