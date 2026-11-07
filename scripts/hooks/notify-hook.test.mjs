import test from 'node:test';
import assert from 'node:assert/strict';
import { main, powershellXmlData } from './notify-hook.js';

test('Claude notification hook is silent by default without reading stdin', () => {
  assert.doesNotThrow(() => main([]));
});

test('Windows notification XML is encoded data, never expandable PowerShell source', () => {
  const xml = '<text>project $(Write-Host injected) `literal` &amp; content</text>';
  const expression = powershellXmlData(xml);
  assert.doesNotMatch(expression, /Write-Host|\$\(|`literal`/);
  const data = /FromBase64String\('([^']+)'/.exec(expression)[1];
  assert.equal(Buffer.from(data, 'base64').toString(), xml);
});
