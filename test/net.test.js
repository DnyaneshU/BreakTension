import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanAddresses, bestLanAddress } from '../server/net.js';

// Shaped like the real output of os.networkInterfaces() on this machine,
// which has both a WSL adapter and real Wi-Fi.
const REAL_WORLD = {
  'vEthernet (WSL)': [{ family: 'IPv4', address: '192.168.192.1', internal: false }],
  'Wi-Fi': [{ family: 'IPv4', address: '192.168.0.111', internal: false }],
  'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
};

test('prefers real Wi-Fi over a WSL virtual adapter', () => {
  // The phone cannot reach 192.168.192.1; picking it silently breaks the QR.
  assert.equal(bestLanAddress(REAL_WORLD), '192.168.0.111');
});

test('skips internal and link-local addresses', () => {
  const addrs = lanAddresses({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'Wi-Fi': [{ family: 'IPv4', address: '169.254.3.4', internal: false }],
  });
  assert.equal(addrs.length, 0);
});

test('ignores IPv6', () => {
  const addrs = lanAddresses({
    'Wi-Fi': [{ family: 'IPv6', address: 'fe80::1', internal: false }],
  });
  assert.equal(addrs.length, 0);
});

test('accepts the numeric family form some Node versions report', () => {
  const addrs = lanAddresses({ 'Wi-Fi': [{ family: 4, address: '192.168.1.5', internal: false }] });
  assert.equal(addrs.length, 1);
});

test('ranks docker and hyper-v below a plain ethernet adapter', () => {
  const best = bestLanAddress({
    'docker0': [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    'Ethernet': [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
  });
  assert.equal(best, '192.168.1.20');
});

test('returns null when there is no external interface at all', () => {
  assert.equal(bestLanAddress({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), null);
});

test('still returns something when only a virtual adapter exists', () => {
  // Better to offer a wrong-but-typable address than nothing.
  const best = bestLanAddress({
    'vEthernet (WSL)': [{ family: 'IPv4', address: '192.168.192.1', internal: false }],
  });
  assert.equal(best, '192.168.192.1');
});
