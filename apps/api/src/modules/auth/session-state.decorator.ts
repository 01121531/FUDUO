import { SetMetadata } from "@nestjs/common";
import type { AuthSessionState } from "@fuduo/database";

export const ALLOWED_SESSION_STATES = "allowed-session-states";

export const AllowSessionStates = (...states: AuthSessionState[]) => SetMetadata(ALLOWED_SESSION_STATES, states);
