-- TRACEFOLIO: local durable tasks, provenance and worker heartbeats.
CREATE TABLE "CareerTask" (
  "id" TEXT NOT NULL PRIMARY KEY, "requestId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'jd_tailoring', "status" TEXT NOT NULL DEFAULT 'queued',
  "revision" INTEGER NOT NULL DEFAULT 1, "input" JSONB NOT NULL, "inputHash" TEXT NOT NULL,
  "proposal" JSONB, "approvalDigest" TEXT, "resultVersionId" TEXT,
  "runtimeThreadId" TEXT, "runtimeTurnId" TEXT, "runtimeVersion" TEXT, "model" TEXT,
  "metrics" JSONB, "error" TEXT, "workerId" TEXT, "leaseUntil" DATETIME,
  "startedAt" DATETIME, "finishedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "CareerTask_requestId_key" ON "CareerTask"("requestId");
CREATE INDEX "CareerTask_status_createdAt_idx" ON "CareerTask"("status", "createdAt");
CREATE TABLE "CareerTaskSource" (
  "id" TEXT NOT NULL PRIMARY KEY, "taskId" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL, "token" TEXT NOT NULL,
  CONSTRAINT "CareerTaskSource_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "CareerTask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CareerTaskSource_taskId_kind_sourceId_key" ON "CareerTaskSource"("taskId", "kind", "sourceId");
CREATE INDEX "CareerTaskSource_kind_sourceId_idx" ON "CareerTaskSource"("kind", "sourceId");
CREATE TABLE "CareerTaskEvent" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "taskId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "message" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CareerTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "CareerTask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CareerTaskEvent_taskId_id_idx" ON "CareerTaskEvent"("taskId", "id");
CREATE TABLE "CareerWorker" ("id" TEXT NOT NULL PRIMARY KEY, "heartbeatAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
