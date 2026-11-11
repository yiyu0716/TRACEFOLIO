import { randomUUID } from "node:crypto";
import type { Database } from "./db";
import type { PlatformModel } from "./config";
import { CloudError, hash, requireAgent, type Account } from "./domain";

export function units(model: PlatformModel, input: number, output: number) {
  return (
    Math.ceil((input * model.inputUnitsPerMillion) / 1_000_000) +
    Math.ceil((output * model.outputUnitsPerMillion) / 1_000_000)
  );
}
export async function reserveUsage(
  db: Database,
  account: Account,
  model: PlatformModel,
  requestKey: string,
  body: string,
  maxOutput: number,
) {
  const reserved = units(model, Buffer.byteLength(body) * 2 + 4096, maxOutput);
  return db.transaction(async (tx) => {
    await tx.query("SELECT id FROM cloud_accounts WHERE id=$1 FOR UPDATE", [
      account.id,
    ]);
    await requireAgent(tx, account);
    const old = (
      await tx.query(
        "SELECT body_hash FROM cloud_usage WHERE account_id=$1 AND request_key=$2",
        [account.id, requestKey],
      )
    ).rows[0];
    if (old)
      throw new CloudError(
        old.body_hash === hash(body)
          ? "此模型请求已被处理或仍待核对；不会重复调用。"
          : "请求编号与内容不匹配。",
        409,
      );
    const grant = (
      await tx.query(
        `SELECT * FROM cloud_grants WHERE account_id=$1 AND model_until>now() AND model_ids ? $2 AND allowance_units-spent_units-reserved_units >= $3 ORDER BY model_until LIMIT 1 FOR UPDATE`,
        [account.id, model.id, reserved],
      )
    ).rows[0];
    if (!grant)
      throw new CloudError(
        "当前套餐没有此模型额度，或可用额度不足以预留本次请求。",
        402,
      );
    const id = randomUUID();
    await tx.query(
      `INSERT INTO cloud_usage (id,account_id,grant_id,request_key,body_hash,model_id,status,reserved_units) VALUES ($1,$2,$3,$4,$5,$6,'reserved',$7)`,
      [id, account.id, grant.id, requestKey, hash(body), model.id, reserved],
    );
    await tx.query(
      "UPDATE cloud_grants SET reserved_units=reserved_units+$1 WHERE account_id=$2 AND id=$3",
      [reserved, account.id, grant.id],
    );
    return { id, reserved };
  });
}
export async function settleUsage(
  db: Database,
  accountId: string,
  id: string,
  model: PlatformModel,
  result: { input: number; output: number } | "released" | "uncertain",
) {
  await db.transaction(async (tx) => {
    await tx.query("SELECT id FROM cloud_accounts WHERE id=$1 FOR UPDATE", [
      accountId,
    ]);
    const row = (
      await tx.query(
        "SELECT * FROM cloud_usage WHERE account_id=$1 AND id=$2 FOR UPDATE",
        [accountId, id],
      )
    ).rows[0];
    if (!row || row.status !== "reserved") return;
    const charge =
      typeof result === "object"
        ? units(model, result.input, result.output)
        : 0;
    // Unknown outcomes keep their hold; never guess a free request from a disconnect.
    if (result === "uncertain" || charge > Number(row.reserved_units)) {
      await tx.query(
        "UPDATE cloud_usage SET status='uncertain',finished_at=now() WHERE account_id=$1 AND id=$2",
        [accountId, id],
      );
      return;
    }
    await tx.query(
      "UPDATE cloud_grants SET reserved_units=reserved_units-$1,spent_units=spent_units+$2 WHERE account_id=$3 AND id=$4",
      [row.reserved_units, charge, accountId, row.grant_id],
    );
    await tx.query(
      "UPDATE cloud_usage SET status=$1,charged_units=$2,input_tokens=$3,output_tokens=$4,finished_at=now() WHERE account_id=$5 AND id=$6",
      [
        result === "released" ? "released" : "settled",
        charge,
        typeof result === "object" ? result.input : null,
        typeof result === "object" ? result.output : null,
        accountId,
        id,
      ],
    );
  });
}

/** Operator-only reconciliation after checking the provider receipt/bill. */
export async function resolveUncertainUsage(
  db: Database,
  accountId: string,
  id: string,
  model: PlatformModel,
  result: { input: number; output: number } | "released",
) {
  return db.transaction(async (tx) => {
    await tx.query("SELECT id FROM cloud_accounts WHERE id=$1 FOR UPDATE", [
      accountId,
    ]);
    const row = (
      await tx.query(
        "SELECT * FROM cloud_usage WHERE account_id=$1 AND id=$2 FOR UPDATE",
        [accountId, id],
      )
    ).rows[0];
    if (!row || row.model_id !== model.id)
      throw new CloudError("用量记录不存在。", 404);
    if (!["reserved", "uncertain"].includes(row.status))
      return { status: row.status };
    if (
      row.status === "reserved" &&
      new Date(row.created_at).getTime() > Date.now() - 300_000
    )
      throw new CloudError("请求仍可能运行，请稍后核对。", 409);
    const charged =
      typeof result === "object"
        ? units(model, result.input, result.output)
        : 0;
    await tx.query(
      "UPDATE cloud_grants SET reserved_units=reserved_units-$1,spent_units=spent_units+$2 WHERE account_id=$3 AND id=$4",
      [row.reserved_units, charged, accountId, row.grant_id],
    );
    const status = result === "released" ? "released" : "settled";
    await tx.query(
      "UPDATE cloud_usage SET status=$1,charged_units=$2,input_tokens=$3,output_tokens=$4,finished_at=now() WHERE account_id=$5 AND id=$6",
      [
        status,
        charged,
        typeof result === "object" ? result.input : null,
        typeof result === "object" ? result.output : null,
        accountId,
        id,
      ],
    );
    return { status };
  });
}

export function readTrustedUsage(
  value: unknown,
  protocol: PlatformModel["protocol"],
): { input: number; output: number } | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  const input = u[protocol === "responses" ? "input_tokens" : "prompt_tokens"],
    output =
      u[protocol === "responses" ? "output_tokens" : "completion_tokens"];
  return Number.isSafeInteger(input) &&
    Number.isSafeInteger(output) &&
    Number(input) >= 0 &&
    Number(output) >= 0 &&
    Number(input) < 1e9 &&
    Number(output) < 1e9
    ? { input: Number(input), output: Number(output) }
    : null;
}

export class UsageStream {
  private buffer = "";
  private decoder = new TextDecoder();
  usage: { input: number; output: number } | null = null;
  completed = false;
  failed = false;
  constructor(private protocol: PlatformModel["protocol"]) {}
  push(chunk: Uint8Array) {
    this.buffer = (
      this.buffer + this.decoder.decode(chunk, { stream: true })
    ).replace(/\r\n/g, "\n");
    if (this.buffer.length > 2_000_000)
      throw new Error("Provider event exceeds limit");
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data === "[DONE]") {
        if (this.protocol === "chat_completions") this.completed = true;
        continue;
      }
      if (!data) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data);
      } catch {
        throw new Error("Malformed provider event");
      }
      if (this.protocol === "responses") {
        if (event.type === "response.completed") {
          this.completed = true;
          this.usage = readTrustedUsage(
            (event.response as Record<string, unknown>)?.usage,
            this.protocol,
          );
        }
        if (
          ["error", "response.failed", "response.incomplete"].includes(
            String(event.type),
          )
        )
          this.failed = true;
      } else {
        if (event.error) this.failed = true;
        if (event.usage)
          this.usage = readTrustedUsage(event.usage, this.protocol);
      }
    }
  }
  result() {
    return this.completed && !this.failed ? this.usage : null;
  }
}
