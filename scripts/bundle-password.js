import { hashPassword } from "../server/bundle-auth.js";
// Read stdin so the password is not stored in command-line history or process arguments.
let password = "";
for await (const chunk of process.stdin) {
  password += chunk;
  if (password.length > 258) throw new Error("Password is too long.");
}
console.log(await hashPassword(password.replace(/\r?\n$/, "")));
