CREATE TABLE "UserShopScope" (
    "userId" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserShopScope_pkey" PRIMARY KEY ("userId", "shopId")
);

CREATE INDEX "UserShopScope_shopId_idx" ON "UserShopScope"("shopId");

ALTER TABLE "UserShopScope" ADD CONSTRAINT "UserShopScope_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserShopScope" ADD CONSTRAINT "UserShopScope_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
