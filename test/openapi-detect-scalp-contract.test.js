import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openApi = fs.readFileSync(path.join(root, 'docs/openapi.yaml'), 'utf8');

const extractPathOperation = (pathname, method) => {
  const pathHeading = `  ${pathname}:`;
  const pathStart = openApi.indexOf(pathHeading);
  assert.notEqual(pathStart, -1, `OpenAPI path ${pathname} must be documented`);
  const nextPath = openApi.indexOf('\n  /', pathStart + pathHeading.length);
  const pathBlock = openApi.slice(pathStart, nextPath === -1 ? openApi.length : nextPath);
  const methodHeading = `    ${method}:`;
  const methodStart = pathBlock.indexOf(methodHeading);
  assert.notEqual(methodStart, -1, `${method.toUpperCase()} ${pathname} must be documented`);
  const nextMethodMatch = /\n {4}(?:get|put|post|patch|delete|options|head|trace):/g;
  nextMethodMatch.lastIndex = methodStart + methodHeading.length;
  const nextMethod = nextMethodMatch.exec(pathBlock);
  return pathBlock.slice(methodStart, nextMethod ? nextMethod.index : pathBlock.length);
};

test('scalp detector OpenAPI contract matches optional auth and two-file upload route', () => {
  const operation = extractPathOperation('/api/v1/hair-tests/detect_scalp_image', 'post');
  assert.match(operation, /security:\s*\[\{\s*bearerAuth:\s*\[\]\s*\},\s*\{\}\s*\]/);
  assert.match(operation, /one image and at most one reference_image \(two files total\)/);
  assert.match(operation, /25 MiB per-file limit and a 90 MiB complete-request ceiling/);
  assert.match(operation, /reference_image:.*format: binary/);
  assert.match(operation, /personMismatch/);
  assert.match(operation, /verificationUnavailable/);
  assert.doesNotMatch(operation, /'401':/);
});

test('scalp detector OpenAPI response map contains unique valid HTTP status keys', () => {
  const operation = extractPathOperation('/api/v1/hair-tests/detect_scalp_image', 'post');
  const responsesStart = operation.indexOf('      responses:\n');
  assert.notEqual(responsesStart, -1, 'the operation must define responses');
  const responseLines = operation.slice(responsesStart).split('\n');
  const statusKeys = [];
  responseLines.forEach((line, index) => {
    const match = line.match(/^ {8}(\S[^:]*):(?:[ \t]*(.*))?$/);
    if (!match) return;
    const status = match[1].trim().replace(/^['"]|['"]$/g, '');
    const inlineValue = match[2]?.trim() || '';
    assert.match(status, /^\d{3}$/, `invalid HTTP response map key: ${status}`);
    if (!inlineValue) assert.match(responseLines[index + 1] || '', /^ {10}\S/, `HTTP response ${status} must have a value`);
    statusKeys.push(status);
  });

  assert.ok(statusKeys.length > 0);
  assert.equal(new Set(statusKeys).size, statusKeys.length, 'duplicate response keys make the OpenAPI map ambiguous');
  assert.ok(statusKeys.includes('413'));
  assert.ok(statusKeys.includes('500'));
});
