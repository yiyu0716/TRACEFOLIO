CREATE TABLE "CareerMemory" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "confirmed" BOOLEAN NOT NULL DEFAULT false,
  "useInAI" BOOLEAN NOT NULL DEFAULT false,
  "expiresAt" DATETIME,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "CareerMemory_key_key" ON "CareerMemory"("key");
CREATE INDEX "CareerMemory_category_updatedAt_idx" ON "CareerMemory"("category", "updatedAt");

CREATE TABLE "CapabilityEvidence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "title" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "excerpt" TEXT NOT NULL,
  "contribution" TEXT NOT NULL,
  "skills" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "useInAI" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "CapabilityEvidence_status_updatedAt_idx" ON "CapabilityEvidence"("status", "updatedAt");

CREATE TABLE "GrowthAction" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "skill" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "evidenceTarget" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "completionEvidenceId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "GrowthAction_completionEvidenceId_fkey" FOREIGN KEY ("completionEvidenceId") REFERENCES "CapabilityEvidence" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GrowthAction_skill_title_key" ON "GrowthAction"("skill", "title");
CREATE INDEX "GrowthAction_status_updatedAt_idx" ON "GrowthAction"("status", "updatedAt");
