import { AsyncLocalStorage } from "node:async_hooks";
import type { DbClient } from "@/lib/db-client/types";

// Keeps nested converted services on the same physical transaction.
export const dbClientContext = new AsyncLocalStorage<DbClient>();
