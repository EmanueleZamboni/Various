import crypto from 'node:crypto';
import { config } from './config.js';

const key = crypto.hkdfSync('sha256', config.secret, 'postino', 'account-secrets', 32);
const keyBuf = Buffer.from(key);

/** AES-256-GCM, output "v1.<iv>.<tag>.<ciphertext>" in base64url. */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decrypt(blob: string): string {
  const [v, ivS, tagS, dataS] = blob.split('.');
  if (v !== 'v1' || !ivS || !tagS || !dataS) throw new Error('Unknown secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(ivS, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagS, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataS, 'base64url')), decipher.final()]).toString('utf8');
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt.${salt.toString('base64url')}.${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, saltS, hashS] = stored.split('.');
  if (algo !== 'scrypt' || !saltS || !hashS) return false;
  const hash = crypto.scryptSync(password.normalize('NFKC'), Buffer.from(saltS, 'base64url'), 32, SCRYPT);
  const expected = Buffer.from(hashS, 'base64url');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
