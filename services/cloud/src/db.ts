import { Pool, type QueryResultRow } from "pg";

export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}

export function postgres(url: string) {
  const pool = new Pool({ connectionString: url, max: 10 });
  const db: Database = {
    query: (sql, values) => pool.query(sql, values),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: Database = {
          query: (sql, values) => client.query(sql, values),
          transaction: (inner) => inner(tx),
        };
        const value = await fn(tx);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return { db, close: () => pool.end() };
}

// The cloud service owns only these tables. Local career APIs/SQLite never run here.
export const schema = `
CREATE TABLE IF NOT EXISTS cloud_accounts (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
 storage_used bigint NOT NULL DEFAULT 0 CHECK (storage_used >= 0),
 storage_reserved bigint NOT NULL DEFAULT 0 CHECK (storage_reserved >= 0),
 active_grant_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cloud_sessions (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_sessions_account ON cloud_sessions(account_id);
CREATE TABLE IF NOT EXISTS cloud_grants (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
 grant_key text NOT NULL, product_id text NOT NULL, agent_until timestamptz,
 lifetime boolean NOT NULL DEFAULT false, model_until timestamptz NOT NULL,
 allowance_units bigint NOT NULL CHECK (allowance_units >= 0),
 spent_units bigint NOT NULL DEFAULT 0 CHECK (spent_units >= 0),
 reserved_units bigint NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
 storage_limit bigint NOT NULL CHECK (storage_limit >= 0), model_ids jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id, grant_key)
);
CREATE TABLE IF NOT EXISTS cloud_documents (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
 request_key text NOT NULL, object_key text NOT NULL UNIQUE, name text NOT NULL, media_type text NOT NULL,
 size bigint NOT NULL CHECK (size > 0), sha256 text NOT NULL, status text NOT NULL,
 storage_counted boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id, request_key), CHECK (status IN ('pending','ready','deleting','failed'))
);
CREATE INDEX IF NOT EXISTS cloud_documents_account ON cloud_documents(account_id, created_at);
CREATE TABLE IF NOT EXISTS cloud_usage (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
 grant_id uuid NOT NULL REFERENCES cloud_grants(id), request_key text NOT NULL,
 body_hash text NOT NULL, model_id text NOT NULL, status text NOT NULL,
 reserved_units bigint NOT NULL, charged_units bigint NOT NULL DEFAULT 0,
 input_tokens bigint, output_tokens bigint, created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz, UNIQUE(account_id,request_key),
 CHECK (status IN ('reserved','settled','released','uncertain'))
);
CREATE INDEX IF NOT EXISTS cloud_usage_account ON cloud_usage(account_id,created_at);
`;
