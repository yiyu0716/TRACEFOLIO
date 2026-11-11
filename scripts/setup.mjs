import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  console.log(".env already exists; preserved existing settings.");
} else {
  writeFileSync(
    ".env",
    [
      'DATABASE_URL="file:./dev.db"',
      `LUJIE_SETTINGS_SECRET="${randomBytes(32).toString("hex")}"`,
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Created .env with a unique local encryption secret. Run npm run db:migrate next.",
  );
}
