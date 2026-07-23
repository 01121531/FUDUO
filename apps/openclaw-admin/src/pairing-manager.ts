import {
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
  type PairingChannel,
} from "openclaw/plugin-sdk/conversation-runtime";

const CHANNEL = "openclaw-weixin" as PairingChannel;
const ACCOUNT_ID = "default";

export class PairingManager {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async list() {
    const [pending, approved] = await Promise.all([
      listChannelPairingRequests(CHANNEL, this.env, ACCOUNT_ID),
      readChannelAllowFromStore(CHANNEL, this.env, ACCOUNT_ID),
    ]);
    return {
      pending: pending.map((request) => ({
        id: request.id,
        code: request.code,
        createdAt: request.createdAt,
        lastSeenAt: request.lastSeenAt,
        meta: request.meta ?? {},
      })),
      approved,
    };
  }

  async approve(code: string) {
    const normalized = code.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(normalized)) throw new Error("PAIRING_CODE_INVALID");
    const result = await approveChannelPairingCode({ channel: CHANNEL, code: normalized, accountId: ACCOUNT_ID, env: this.env });
    if (!result) throw new Error("PAIRING_CODE_NOT_FOUND");
    return { externalUserId: result.id, meta: result.entry?.meta ?? {} };
  }

  async revoke(externalUserId: string) {
    const normalized = externalUserId.trim();
    if (!normalized || normalized.length > 256) throw new Error("PAIRING_USER_INVALID");
    const result = await removeChannelAllowFromStoreEntry({ channel: CHANNEL, entry: normalized, accountId: ACCOUNT_ID, env: this.env });
    return { externalUserId: normalized, revoked: result.changed };
  }
}
