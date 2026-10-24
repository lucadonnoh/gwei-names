import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutoModeError, encodeAutoCall, encodeAutoReturn, isMimeType, keccak256, parseAutoQuery, parseDataUrl,
} from './web3-auto.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const kec = (s) => hex(keccak256(new TextEncoder().encode(s)));
const pad32 = (h) => h.padStart(64, '0');

// Reference values below come from Foundry's `cast keccak`, `cast calldata` and `cast abi-encode`.
test('keccak256 matches reference digests, including at the 136-byte block boundary', () => {
  assert.equal(kec(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(kec('resolveMode()').slice(0, 8), 'dd473fae');
  assert.equal(kec('html()').slice(0, 8), '33c34ac3');
  assert.equal(kec('x'.repeat(135)).slice(0, 16), '16570bdb055e663e');
  assert.equal(kec('x'.repeat(136)).slice(0, 16), '50da8ef3747b7a7f');
  assert.equal(kec('x'.repeat(300)).slice(0, 16), '956875d0d3af4718');
});

test('the root is a call with empty calldata', () => {
  for (const path of ['/', '']) assert.deepEqual(encodeAutoCall(path), { data: '0x', root: true, lastArg: null });
});

test('arguments are typed by detection, as in the ERC-6860 examples', () => {
  assert.equal(encodeAutoCall('/renderBroker/9999').data, '0x7ccdcaa1' + pad32('270f'));
  assert.equal(
    encodeAutoCall('/balanceOf/0x00000000000000000000000000000000DeaDBeef').data,
    '0x70a08231' + pad32('deadbeef'),
  );
  assert.equal(encodeAutoCall('/html/').data, '0x33c34ac3', 'a trailing slash is ignored');
});

test('explicit types and dynamic arguments encode like cast calldata', () => {
  const b32 = '0x' + 'ab'.repeat(32);
  const { data, lastArg } = encodeAutoCall(`/f/${b32}/0x1234/true/int8!-5/string!h%C3%A9%2Fllo.svg/bytes2!0xbeef`);
  assert.equal(data, '0xfdcea8bf' + 'ab'.repeat(32) +
    pad32('c0') + pad32('1') + 'f'.repeat(63) + 'b' + pad32('100') + 'beef'.padEnd(64, '0') +
    pad32('2') + '1234'.padEnd(64, '0') + pad32('b') + '68c3a92f6c6c6f2e737667'.padEnd(64, '0'));
  assert.deepEqual(lastArg, { type: { kind: 'bytes', size: 2 }, value: '0xbeef' });
  assert.equal(encodeAutoCall('/file/string!logo.svg').lastArg.value, 'logo.svg');
});

test('invalid paths and arguments are rejected before any call', () => {
  const status = (path) => {
    try {
      encodeAutoCall(path);
    } catch (error) {
      assert.ok(error instanceof AutoModeError);
      return error.status;
    }
    return null;
  };
  assert.equal(status('/favicon.ico'), 404, 'not a method name');
  assert.equal(status('/f/vitalik.eth'), 400, 'name-service arguments');
  assert.equal(status('/f/uint8!256'), 400, 'out of range');
  assert.equal(status('/f/int8!-129'), 400, 'out of range');
  assert.equal(status('/f/bytes2!0x12'), 400, 'wrong length');
  assert.equal(status('/f/float!1'), 400, 'unknown type');
  assert.equal(status('/f/%E0%A4%A'), 400, 'bad percent-encoding');
});

test('query attributes: last wins, + is kept, unknown attributes are ignored', () => {
  assert.deepEqual(parseAutoQuery('?returns=(uint256)&x=1&returnTypes=(bool)'), { returns: '(bool)', mime: null });
  assert.deepEqual(parseAutoQuery('?returns='), { returns: undefined, mime: null });
  assert.deepEqual(parseAutoQuery('?mime.type=svg&mime.content=image/svg+xml'), { returns: undefined, mime: { content: 'image/svg+xml' } });
  assert.deepEqual(parseAutoQuery('?mime.content=image/svg%2Bxml&mime.dataurl'), { returns: undefined, mime: { dataurl: true } });
});

test('typed returns decode to JSON-RPC style values', () => {
  const d1 = '0x' + pad32('0') + pad32('a0') + pad32('deadbeef') + pad32('1') + 'f'.repeat(61) + 'ed4' +
    pad32('6') + '686920e29c93'.padEnd(64, '0');
  assert.equal(encodeAutoReturn(d1, '(uint256,string,address,bool,int16)'),
    '["0x0","hi ✓","0x00000000000000000000000000000000deadbeef",true,"-0x12c"]');

  const d2 = '0x' + pad32('60') + pad32('e0') + pad32('220') +
    pad32('3') + pad32('1') + pad32('2') + pad32('3') +
    pad32('40') + pad32('c0') +
    pad32('40') + '01020304'.padEnd(64, '0') + pad32('1') + '61'.padEnd(64, '0') +
    pad32('40') + 'ffffffff'.padEnd(64, '0') + pad32('3') + '626364'.padEnd(64, '0') +
    pad32('3') + 'c0ffee'.padEnd(64, '0');
  assert.equal(encodeAutoReturn(d2, '(uint8[],(string,bytes4)[2],bytes)'),
    '[["0x1","0x2","0x3"],[["a","0x01020304"],["bcd","0xffffffff"]],"0xc0ffee"]');

  assert.equal(encodeAutoReturn('0x1234', '()'), '["0x1234"]');
});

test('return data that does not fit the types is a 502, and array claims are bounded', () => {
  const rejects = (result, returns, status) => assert.throws(
    () => encodeAutoReturn(result, returns),
    (error) => error instanceof AutoModeError && error.status === status,
  );
  rejects('0x' + pad32('1'), '(uint256,uint256)', 502);
  rejects('0x' + pad32('20') + pad32('ffffffff'), '(uint256[])', 502);
  rejects('0x', '(uint256[99999999999])', 502);
  rejects('0x' + pad32('1'), '(float)', 400);
  rejects('0x' + pad32('1'), 'uint256', 400);

  // 64 elements all pointing at one 64 KiB string: small on the wire, 4 MiB decoded.
  const n = 64, len = 64 * 1024;
  const shared = pad32(len.toString(16)) + '61'.repeat(len);
  const amplified = '0x' + pad32('20') + pad32(n.toString(16)) + pad32((n * 32).toString(16)).repeat(n) + shared;
  rejects(amplified, '(string[])', 502);
});

test('data URLs decode base64 and percent-encoded payloads', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.deepEqual(parseDataUrl(enc('data:application/json,%5B%22xx%22%5D')), {
    contentType: 'application/json', body: enc('["xx"]'),
  });
  assert.deepEqual(parseDataUrl(enc('data:image/svg+xml;base64,PHN2Zy8+')), {
    contentType: 'image/svg+xml', body: enc('<svg/>'),
  });
  assert.equal(parseDataUrl(enc('data:,é')).contentType, 'text/plain;charset=US-ASCII');
  assert.deepEqual(parseDataUrl(enc('data:,é')).body, enc('é'));
  assert.equal(parseDataUrl(enc('not a data url')), null);
});

test('mime.content values must be MIME types', () => {
  assert.ok(isMimeType('image/svg+xml'));
  assert.ok(isMimeType('text/html; charset=utf-8'));
  assert.ok(!isMimeType('text/html\r\nx-injected: yes'));
  assert.ok(!isMimeType('html'));
});
