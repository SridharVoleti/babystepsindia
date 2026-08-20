import { AsyncLocalStorage } from "node:async_hooks";
import type { DbClient } from "@/lib/db-client/types";

// Split into its own module (not index.ts) purely to avoid a circular
// import between index.ts and postgres-adapter.ts — both need to read/set
// this same context. See index.ts's resolveDbClient() for what problem
// this solves and why.
export const dbClientContext = new AsyncLocalStorage<DbClient>();
