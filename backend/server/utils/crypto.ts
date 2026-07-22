import crypto from "crypto";
import { config } from "../config";

const ALGORITHM = "aes-256-cbc";

// Enforce safe 32-byte key deriving
const getEncryptionKey = (): Buffer => {
  return Buffer.from(config.ENCRYPTION_KEY.padEnd(32, "!").substring(0, 32));
};

export function encrypt(text: string): string {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    return `${iv.toString("hex")}:${encrypted}`;
  } catch (err) {
    console.error("Encryption error:", err);
    throw new Error("Failed to securely encrypt sensitive config");
  }
}

export function decrypt(encryptedText: string): string {
  try {
    const [ivHex, encryptedHex] = encryptedText.split(":");
    if (!ivHex || !encryptedHex) throw new Error("Invalid encrypted format");
    
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error("Decryption error:", err);
    throw new Error("Failed to decrypt secure config payload");
  }
}
