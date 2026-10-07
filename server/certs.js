import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * A self-signed certificate for the LAN server.
 *
 * `getUserMedia` only works in a secure context. `localhost` counts as one,
 * but `https://192.168.0.111` does not unless it is actually HTTPS — so the
 * phone cannot open the camera over plain HTTP. This is the single biggest
 * trap in the whole project.
 *
 * We generate a cert with a SAN for the LAN IP so the browser's warning is
 * the ordinary "unknown issuer" one, which the user can accept on their own
 * device, rather than a hard name-mismatch failure.
 */
export function ensureCert({ dir = 'certs', host = '127.0.0.1' } = {}) {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const metaPath = join(dir, 'host.txt');

  const sameHost = existsSync(metaPath) && readFileSync(metaPath, 'utf8').trim() === host;
  if (existsSync(keyPath) && existsSync(certPath) && sameHost) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath), reused: true };
  }

  const made = generate({ host, keyPath, certPath });
  if (!made) return null;

  writeFileSync(metaPath, host);
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), reused: false };
}

function generate({ host, keyPath, certPath }) {
  // Prefer openssl: it ships with Git for Windows, macOS and most Linux.
  const conf = `[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=BreakTension
[v3]
subjectAltName=IP:${host},DNS:localhost,IP:127.0.0.1
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
`;
  const confPath = `${certPath}.cnf`;
  try {
    writeFileSync(confPath, conf);
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '365', '-config', confPath],
      { stdio: 'ignore' }
    );
    return true;
  } catch {
    return tryNodeForge({ host, keyPath, certPath });
  }
}

/** Fallback if openssl is missing and node-forge happens to be installed. */
function tryNodeForge({ host, keyPath, certPath }) {
  try {
    const require = createRequire(import.meta.url);
    const forge = require('node-forge');
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date(Date.now() + 365 * 864e5);
    const attrs = [{ name: 'commonName', value: 'BreakTension' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: host }, { type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
    ]);
    cert.sign(keys.privateKey);
    writeFileSync(keyPath, forge.pki.privateKeyToPem(keys.privateKey));
    writeFileSync(certPath, forge.pki.certificateToPem(cert));
    return true;
  } catch {
    return false;
  }
}
