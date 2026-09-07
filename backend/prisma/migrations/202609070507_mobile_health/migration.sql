CREATE TABLE "mobile_health_devices" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "pseudonym" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "versionCode" INTEGER NOT NULL,
    "androidApi" INTEGER,
    "deviceModel" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tunnelState" TEXT NOT NULL,
    "protocol" TEXT,
    "lastOutcome" TEXT NOT NULL DEFAULT 'none',
    "lastErrorCode" TEXT,
    "sessionDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "reconnectCount" INTEGER NOT NULL DEFAULT 0,
    "activeDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "backgroundDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "wakeCount" INTEGER NOT NULL DEFAULT 0,
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "batteryOptimization" TEXT NOT NULL DEFAULT 'unknown',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mobile_health_devices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mobile_health_reports" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tunnelState" TEXT NOT NULL,
    "protocol" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'none',
    "errorCode" TEXT,
    "sessionDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "reconnectCount" INTEGER NOT NULL DEFAULT 0,
    "activeDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "backgroundDurationSeconds" INTEGER NOT NULL DEFAULT 0,
    "wakeCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "mobile_health_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mobile_health_devices_pseudonym_key" ON "mobile_health_devices"("pseudonym");
CREATE UNIQUE INDEX "mobile_health_reports_reportId_key" ON "mobile_health_reports"("reportId");
CREATE INDEX "mobile_health_devices_lastSeenAt_idx" ON "mobile_health_devices"("lastSeenAt");
CREATE INDEX "mobile_health_devices_versionCode_idx" ON "mobile_health_devices"("versionCode");
CREATE INDEX "mobile_health_reports_reportedAt_idx" ON "mobile_health_reports"("reportedAt");
CREATE INDEX "mobile_health_reports_deviceId_reportedAt_idx" ON "mobile_health_reports"("deviceId", "reportedAt");
CREATE INDEX "mobile_health_reports_outcome_reportedAt_idx" ON "mobile_health_reports"("outcome", "reportedAt");

ALTER TABLE "mobile_health_reports"
ADD CONSTRAINT "mobile_health_reports_deviceId_fkey"
FOREIGN KEY ("deviceId") REFERENCES "mobile_health_devices"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
