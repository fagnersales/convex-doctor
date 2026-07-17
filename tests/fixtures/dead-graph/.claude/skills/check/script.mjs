import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const convex = new ConvexHttpClient(process.env.CONVEX_URL);
const result = await convex.query(anyApi.funcs.dotDirCalled, {});
console.log(result);
