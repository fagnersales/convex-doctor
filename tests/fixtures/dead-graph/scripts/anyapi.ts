import { anyApi } from "convex/server";

declare const client: { query(ref: unknown, args: unknown): Promise<unknown> };

export async function poll() {
  return client.query(anyApi.funcs.anyApiCalled, {});
}
