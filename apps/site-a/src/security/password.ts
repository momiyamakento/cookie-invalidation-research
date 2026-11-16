import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;
const HASH_PREFIX = "scrypt";

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEMORY },
      (error, derivedKey) => {
        if (error !== null) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await deriveKey(password, salt);

  return [
    HASH_PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const parts = encodedHash.split("$");
  if (parts.length !== 6) {
    return false;
  }

  const [prefix, nText, rText, pText, saltText, hashText] = parts;
  if (
    prefix !== HASH_PREFIX ||
    nText !== String(SCRYPT_N) ||
    rText !== String(SCRYPT_R) ||
    pText !== String(SCRYPT_P) ||
    saltText === undefined ||
    hashText === undefined
  ) {
    return false;
  }

  try {
    const expected = Buffer.from(hashText, "base64url");
    if (expected.length !== KEY_LENGTH) {
      return false;
    }

    const actual = await deriveKey(password, Buffer.from(saltText, "base64url"));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
