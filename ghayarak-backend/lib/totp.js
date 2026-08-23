const crypto = require("crypto");

// Base32 (RFC 4648) — TOTP secrets are conventionally base32, since that's
// what authenticator apps expect when a secret is entered/scanned.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function generateSecret(byteLength = 20) {
  const bytes = crypto.randomBytes(byteLength);
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let secret = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return secret;
}

function base32ToBuffer(base32) {
  const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secretBuffer, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, "0");
}

// Accepts a code from the current 30s window or either adjacent window, to
// tolerate normal clock drift between the server and the user's phone.
function verifyTotp(base32Secret, code, options) {
  const step = (options && options.step) || 30;
  const window = (options && options.window) || 1;
  if (!/^\d{6}$/.test(code)) return false;
  const secretBuffer = base32ToBuffer(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / step);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    if (hotp(secretBuffer, counter + errorWindow) === code) return true;
  }
  return false;
}

function otpAuthUrl(base32Secret, accountLabel, issuer) {
  const issuerName = issuer || "Ghayarak";
  const encodedLabel = encodeURIComponent(issuerName + ":" + accountLabel);
  const encodedIssuer = encodeURIComponent(issuerName);
  return "otpauth://totp/" + encodedLabel + "?secret=" + base32Secret + "&issuer=" + encodedIssuer + "&algorithm=SHA1&digits=6&period=30";
}

module.exports = { generateSecret, verifyTotp, otpAuthUrl };
