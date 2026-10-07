import { networkInterfaces } from 'node:os';

/**
 * Find the LAN address the phone should use to reach this laptop.
 *
 * Virtual adapters (WSL, Docker, Hyper-V, VirtualBox) are routinely present
 * on a dev machine and are not reachable from a phone, so they are ranked
 * last rather than trusted. Private home ranges come first.
 */
export function lanAddresses(ifaces = networkInterfaces()) {
  const out = [];

  for (const [name, addrs] of Object.entries(ifaces ?? {})) {
    for (const a of addrs ?? []) {
      const family = a.family === 'IPv4' || a.family === 4;
      if (!family || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // link-local, not routable
      out.push({ name, address: a.address, score: scoreInterface(name, a.address) });
    }
  }

  return out.sort((x, y) => y.score - x.score);
}

function scoreInterface(name, address) {
  const n = name.toLowerCase();
  let score = 0;

  // Real Wi-Fi is what a phone is almost always on.
  if (/wi-?fi|wlan|wireless/.test(n)) score += 40;
  else if (/ethernet|eth\d|en[0-9]/.test(n)) score += 25;

  // Typical home router ranges.
  if (/^192\.168\./.test(address)) score += 20;
  else if (/^10\./.test(address)) score += 10;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 5;

  // Adapters a phone cannot reach.
  if (/wsl|docker|hyper-?v|vethernet|virtualbox|vmware|loopback|tailscale|zerotier/.test(n)) score -= 60;

  return score;
}

/** The single best guess, or null if there is no usable LAN address. */
export function bestLanAddress(ifaces) {
  const list = lanAddresses(ifaces);
  return list.length > 0 && list[0].score > 0 ? list[0].address : (list[0]?.address ?? null);
}
