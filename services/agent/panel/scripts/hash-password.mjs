// Print PANEL_PASSWORD_HASH for the panel without putting the password in .env.
// Usage: node scripts/hash-password.mjs 'correct horse battery staple'

import { randomBytes, scryptSync } from "node:crypto";

const password = process.argv[2];
if (!password) {
  console.error("usage: node scripts/hash-password.mjs '<password>'");
  process.exit(2);
}
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32);
console.log(`scrypt:${salt.toString("hex")}:${hash.toString("hex")}`);
