import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { postgres, schema } from "./db";
import { cloudConfig } from "./bootstrap";
import { grantProduct } from "./domain";
import { reconcileUploads } from "./documents";
import { resolveUncertainUsage } from "./usage";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = cloudConfig(),
  { db, close } = postgres(config.databaseUrl);
try {
  await db.query(schema);
  const [command, email, productId, grantKey, outputTokens] =
    process.argv.slice(2);
  if (command === "grant") {
    const account = (
      await db.query("SELECT id FROM cloud_accounts WHERE email=$1", [
        email?.toLowerCase(),
      ])
    ).rows[0];
    const product = config.products.find((p) => p.id === productId);
    if (!account || !product) throw new Error("Unknown account or product");
    const key = grantKey ?? randomUUID();
    await grantProduct(db, account.id, product, key);
    console.log(`Entitlement granted. Receipt: ${key}`);
  } else if (command === "reconcile-uploads")
    console.log(
      `Recovered ${await reconcileUploads(db, config.storage)} pending uploads.`,
    );
  else if (command === "resolve-usage") {
    const account = (
      await db.query("SELECT id FROM cloud_accounts WHERE email=$1", [
        email?.toLowerCase(),
      ])
    ).rows[0];
    const usage = account
      ? (
          await db.query(
            "SELECT model_id FROM cloud_usage WHERE account_id=$1 AND id=$2",
            [account.id, productId],
          )
        ).rows[0]
      : null;
    const model = config.models.find((m) => m.id === usage?.model_id);
    if (!account || !model) throw new Error("Unknown account or usage model");
    if (
      grantKey !== "release" &&
      ![grantKey, outputTokens].every(
        (v) =>
          v !== undefined &&
          /^\d+$/.test(v) &&
          Number.isSafeInteger(Number(v)) &&
          Number(v) < 1e9,
      )
    )
      throw new Error("Supply release or trusted input/output token counts");
    console.log(
      await resolveUncertainUsage(
        db,
        account.id,
        productId,
        model,
        grantKey === "release"
          ? "released"
          : { input: Number(grantKey), output: Number(outputTokens) },
      ),
    );
  } else if (command === "usage") {
    const result = await db.query(
      "SELECT u.id,u.status,u.model_id,u.reserved_units,u.charged_units,u.created_at FROM cloud_usage u JOIN cloud_accounts a ON a.id=u.account_id WHERE a.email=$1 ORDER BY u.created_at DESC LIMIT 100",
      [email?.toLowerCase()],
    );
    console.table(result.rows);
  } else
    throw new Error(
      "Usage: admin grant <email> <product-id> [receipt-key] | reconcile-uploads | usage <email> | resolve-usage <email> <usage-id> release|<input-tokens> [output-tokens]",
    );
} finally {
  await close();
}
