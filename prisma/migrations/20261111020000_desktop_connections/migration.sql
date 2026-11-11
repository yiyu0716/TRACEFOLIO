ALTER TABLE "CareerTask" ADD COLUMN "modelBinding" TEXT;
CREATE TABLE "ModelProfile" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "label" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'byok',
  "providerId" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "protocol" TEXT NOT NULL,
  "secret" TEXT NOT NULL DEFAULT '',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "LocalConnection" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
  "activeProfileId" TEXT,
  "cloudBaseUrl" TEXT NOT NULL DEFAULT '',
  "cloudSession" TEXT NOT NULL DEFAULT '',
  "updatedAt" DATETIME NOT NULL
);
