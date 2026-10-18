import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

export const nonce = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function equalSecret(left: string, right: string): boolean {
  return timingSafeEqual(
    Buffer.from(digest(left), "hex"),
    Buffer.from(digest(right), "hex"),
  );
}

/** Derive login keys without blocking the controller's reconciliation loop. */
export function passwordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Bind ciphertext to its record name so credentials cannot be swapped between owners. */
export function seal(key: Buffer, name: string, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function unseal(key: Buffer, name: string, ciphertext: string): string {
  const bytes = Buffer.from(ciphertext, "base64");
  if (bytes.length < 28) throw new Error("Invalid stored credential.");
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(name));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}
