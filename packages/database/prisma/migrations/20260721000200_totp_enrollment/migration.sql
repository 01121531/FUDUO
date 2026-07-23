-- CreateTable
CREATE TABLE "TotpEnrollment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "secretCipher" BYTEA NOT NULL,
    "secretIv" BYTEA NOT NULL,
    "secretTag" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TotpEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TotpEnrollment_userId_key" ON "TotpEnrollment"("userId");

-- AddForeignKey
ALTER TABLE "TotpEnrollment" ADD CONSTRAINT "TotpEnrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
