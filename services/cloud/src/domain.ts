import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { Database } from "./db";
import type { Product } from "./config";

const derive = promisify(scrypt);
export class CloudError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const opaqueToken = () => randomBytes(32).toString("base64url");
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await derive(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function passwordMatches(password: string, stored: string) {
  const [, salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const candidate = (await derive(password, salt, 64)) as Buffer;
  const expected = Buffer.from(key, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

export type Account = { id: string; email: string };
export async function authenticate(
  db: Database,
  authorization?: string,
): Promise<Account> {
  const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new CloudError("请先登录 TRACEFOLIO 账号。", 401);
  const { rows } = await db.query<Account>(
    `SELECT a.id,a.email FROM cloud_sessions s JOIN cloud_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now()`,
    [hash(token)],
  );
  if (!rows[0]) throw new CloudError("登录已过期，请重新登录。", 401);
  return rows[0];
}

export async function grantProduct(
  db: Database,
  accountId: string,
  product: Product,
  grantKey: string,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      "SELECT id FROM cloud_accounts WHERE id=$1 FOR UPDATE",
      [accountId],
    );
    if (!rows[0]) throw new CloudError("账号不存在。", 404);
    const old = await tx.query(
      "SELECT * FROM cloud_grants WHERE account_id=$1 AND grant_key=$2",
      [accountId, grantKey],
    );
    if (old.rows[0]) {
      if (old.rows[0].product_id !== product.id)
        throw new CloudError("开通编号已用于其他产品。", 409);
      return old.rows[0];
    }
    // Existing active rights are extended, and lifetime rights survive later bundles.
    const current = await tx.query(
      `SELECT g.* FROM cloud_accounts a JOIN cloud_grants g ON g.id=a.active_grant_id AND g.account_id=a.id WHERE a.id=$1`,
      [accountId],
    );
    const previous = current.rows[0];
    const base = new Date(
      Math.max(
        now.getTime(),
        previous?.agent_until ? new Date(previous.agent_until).getTime() : 0,
      ),
    );
    const end = new Date(base);
    if (product.term === "month") end.setUTCMonth(end.getUTCMonth() + 1);
    if (product.term === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
    const lifetime = product.term === "lifetime" || previous?.lifetime === true;
    const id = randomUUID();
    const modelUntil = new Date(now.getTime() + product.modelDays * 86400_000);
    // Separate grants retain prior model balances; an Agent-only renewal never erases paid tokens.
    const result = await tx.query(
      `INSERT INTO cloud_grants (id,account_id,grant_key,product_id,agent_until,lifetime,model_until,allowance_units,storage_limit,model_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
      [
        id,
        accountId,
        grantKey,
        product.id,
        lifetime ? null : end,
        lifetime,
        modelUntil,
        product.allowanceUnits,
        product.storageBytes,
        JSON.stringify(product.models),
      ],
    );
    await tx.query("UPDATE cloud_accounts SET active_grant_id=$1 WHERE id=$2", [
      id,
      accountId,
    ]);
    return result.rows[0];
  });
}

export async function entitlement(db: Database, account: Account) {
  const { rows } = await db.query(
    `SELECT a.storage_used,a.storage_reserved,g.product_id,g.agent_until,g.lifetime,g.storage_limit FROM cloud_accounts a LEFT JOIN cloud_grants g ON g.id=a.active_grant_id AND g.account_id=a.id WHERE a.id=$1`,
    [account.id],
  );
  const row = rows[0];
  const active = Boolean(
    row &&
    (row.lifetime ||
      (row.agent_until && new Date(row.agent_until) > new Date())),
  );
  const { rows: balances } = await db.query(
    `SELECT product_id,model_until,allowance_units,spent_units,reserved_units,model_ids FROM cloud_grants WHERE account_id=$1 AND model_until>now() AND allowance_units>0 ORDER BY model_until`,
    [account.id],
  );
  return {
    account,
    agent: {
      active,
      lifetime: row?.lifetime ?? false,
      until: row?.agent_until ?? null,
      productId: row?.product_id ?? null,
    },
    storage: {
      usedBytes: Number(row?.storage_used ?? 0),
      reservedBytes: Number(row?.storage_reserved ?? 0),
      limitBytes: active ? Number(row?.storage_limit ?? 0) : 0,
    },
    balances: balances.map((b) => ({
      productId: b.product_id,
      until: b.model_until,
      remainingUnits:
        Number(b.allowance_units) -
        Number(b.spent_units) -
        Number(b.reserved_units),
      models: b.model_ids as string[],
    })),
  };
}
export async function requireAgent(db: Database, account: Account) {
  const e = await entitlement(db, account);
  if (!e.agent.active)
    throw new CloudError(
      "请先开通 Agent 使用权。自带密钥和平台模型额度独立于使用权。",
      403,
    );
  return e;
}
