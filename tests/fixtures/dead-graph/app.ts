import { api } from "./convex/_generated/api";

declare function useQuery(ref: unknown, args: unknown): unknown;

export function AliveWidget() {
  return useQuery(api.funcs.alive, {});
}
