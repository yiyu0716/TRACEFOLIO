import { randomUUID } from "node:crypto";
import type { Database } from "./db";
import { CloudError, hash, requireAgent, type Account } from "./domain";
import type { ObjectStorage } from "./storage";
import { MAX_DOCUMENT_BYTES } from "./storage";

export const documentView = (d: Record<string, unknown>) => ({
  id: d.id,
  name: d.name,
  size: Number(d.size),
  mediaType: d.media_type,
  sha256: d.sha256,
  status: d.status,
  revision: d.revision,
  createdAt: d.created_at,
});
export async function uploadDocument(
  db: Database,
  storage: ObjectStorage,
  account: Account,
  input: { name: string; mediaType: string; requestKey: string; data: Buffer },
) {
  if (input.data.length === 0 || input.data.length > MAX_DOCUMENT_BYTES)
    throw new CloudError("单份资料需在 1 字节至 20 MiB 之间。", 413);
  const digest = hash(input.data);
  const reservation = await db.transaction(async (tx) => {
    await tx.query("SELECT id FROM cloud_accounts WHERE id=$1 FOR UPDATE", [
      account.id,
    ]);
    const old = (
      await tx.query(
        "SELECT * FROM cloud_documents WHERE account_id=$1 AND request_key=$2",
        [account.id, input.requestKey],
      )
    ).rows[0];
    if (old) {
      if (
        old.sha256 !== digest ||
        old.name !== input.name ||
        old.media_type !== input.mediaType
      )
        throw new CloudError("上传编号已对应其他资料。", 409);
      if (old.status === "ready") return { existing: old };
      throw new CloudError(
        "此上传尚未完成或已失败，请刷新状态后使用新的上传编号重试。",
        409,
      );
    }
    const e = await requireAgent(tx, account);
    if (
      e.storage.usedBytes + e.storage.reservedBytes + input.data.length >
      e.storage.limitBytes
    )
      throw new CloudError("云端资料空间不足。", 402);
    const id = randomUUID(),
      objectKey = `${account.id}/${id}/${digest}`;
    const row = (
      await tx.query(
        `INSERT INTO cloud_documents (id,account_id,request_key,object_key,name,media_type,size,sha256,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
        [
          id,
          account.id,
          input.requestKey,
          objectKey,
          input.name,
          input.mediaType,
          input.data.length,
          digest,
        ],
      )
    ).rows[0];
    await tx.query(
      "UPDATE cloud_accounts SET storage_reserved=storage_reserved+$1 WHERE id=$2",
      [input.data.length, account.id],
    );
    return { pending: row };
  });
  if (reservation.existing) return documentView(reservation.existing);
  const doc = reservation.pending!;
  try {
    await storage.put(doc.object_key, input.data);
    await finalizeUpload(db, account.id, doc.id, true);
  } catch (error) {
    // A possibly successful PUT is safe to reconcile, not to erase on a network timeout.
    // Keep the reservation/pending row; maintenance verifies the object before settling.
    throw error;
  }
  return documentView(
    (
      await db.query(
        "SELECT * FROM cloud_documents WHERE account_id=$1 AND id=$2",
        [account.id, doc.id],
      )
    ).rows[0],
  );
}
async function finalizeUpload(
  db: Database,
  accountId: string,
  id: string,
  exists: boolean,
) {
  await db.transaction(async (tx) => {
    await tx.query("SELECT id FROM cloud_accounts WHERE id=$1 FOR UPDATE", [
      accountId,
    ]);
    const d = (
      await tx.query(
        "SELECT * FROM cloud_documents WHERE account_id=$1 AND id=$2 FOR UPDATE",
        [accountId, id],
      )
    ).rows[0];
    if (!d || d.status !== "pending") return;
    await tx.query(
      "UPDATE cloud_documents SET status=$1,storage_counted=$2,revision=revision+1 WHERE account_id=$3 AND id=$4",
      [exists ? "ready" : "failed", exists, accountId, id],
    );
    await tx.query(
      "UPDATE cloud_accounts SET storage_reserved=storage_reserved-$1,storage_used=storage_used+$2 WHERE id=$3",
      [d.size, exists ? d.size : 0, accountId],
    );
  });
}
export async function downloadDocument(
  db: Database,
  storage: ObjectStorage,
  account: Account,
  id: string,
) {
  const d = (
    await db.query(
      "SELECT * FROM cloud_documents WHERE account_id=$1 AND id=$2 AND status='ready'",
      [account.id, id],
    )
  ).rows[0];
  if (!d) throw new CloudError("资料不存在。", 404);
  const data = await storage.get(d.object_key);
  if (!data || data.length !== Number(d.size) || hash(data) !== d.sha256)
    throw new CloudError("资料完整性校验失败或对象丢失。", 502);
  return { data, document: d };
}
export async function deleteDocument(
  db: Database,
  storage: ObjectStorage,
  account: Account,
  id: string,
  revision: number,
) {
  const d = await db.transaction(async (tx) => {
    await tx.query("SELECT id FROM cloud_accounts WHERE id=$1 FOR UPDATE", [
      account.id,
    ]);
    const doc = (
      await tx.query(
        "SELECT * FROM cloud_documents WHERE account_id=$1 AND id=$2 FOR UPDATE",
        [account.id, id],
      )
    ).rows[0];
    if (!doc) return null;
    if (!["ready", "deleting", "failed"].includes(doc.status))
      throw new CloudError("资料仍在上传，请稍后重试。", 409);
    if (doc.revision !== revision)
      throw new CloudError("资料状态已变化，请刷新后重试。", 409);
    if (doc.status !== "deleting")
      await tx.query(
        "UPDATE cloud_documents SET status='deleting' WHERE account_id=$1 AND id=$2",
        [account.id, id],
      );
    return doc;
  });
  if (!d) return;
  await storage.delete(d.object_key);
  await db.transaction(async (tx) => {
    await tx.query("SELECT id FROM cloud_accounts WHERE id=$1 FOR UPDATE", [
      account.id,
    ]);
    const row = (
      await tx.query(
        "DELETE FROM cloud_documents WHERE account_id=$1 AND id=$2 AND status='deleting' RETURNING *",
        [account.id, id],
      )
    ).rows[0];
    // Failed uploads have already released their reservation and never consumed space.
    if (row?.storage_counted)
      await tx.query(
        "UPDATE cloud_accounts SET storage_used=storage_used-$1 WHERE id=$2",
        [row.size, account.id],
      );
  });
}

export async function reconcileUploads(db: Database, storage: ObjectStorage) {
  const pending = (
    await db.query(
      "SELECT * FROM cloud_documents WHERE status='pending' AND created_at < now()-interval '10 minutes'",
    )
  ).rows;
  let recovered = 0;
  for (const d of pending) {
    const data = await storage.get(d.object_key);
    if (data && (data.length !== Number(d.size) || hash(data) !== d.sha256))
      throw new Error(
        "Pending object integrity mismatch; operator review required",
      );
    await finalizeUpload(db, d.account_id, d.id, Boolean(data));
    recovered++;
  }
  return recovered;
}
