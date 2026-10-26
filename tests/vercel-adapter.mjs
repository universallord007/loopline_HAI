import assert from "node:assert/strict";
import { Readable } from "node:stream";

const records = new Map();
let currentLock = null;
process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-only";
globalThis.fetch = async (_url, options) => {
  const [operation, ...args] = JSON.parse(options.body);
  let result = null;
  if (operation === "SET") {
    const [key, value, ...flags] = args;
    if (flags.includes("NX") && records.has(key)) result = null;
    else { records.set(key, value); if (flags.includes("NX")) currentLock = value; result = "OK"; }
  } else if (operation === "GET") result = records.get(args[0]) ?? null;
  else if (operation === "EVAL") { if (currentLock === args[3]) { records.delete(args[2]); currentLock = null; result = 1; } else result = 0; }
  return Response.json({ result });
};
const { default: handler } = await import("../api/[...path].mjs");
function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method; req.url = url; req.headers = {};
  const res = {
    statusCode: 200, headers: {}, writableEnded: false, body: "",
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); },
    end(value = "") { this.body = String(value); this.writableEnded = true; },
  };
  return handler(req, res).then(() => ({ status: res.statusCode, data: JSON.parse(res.body || "{}") }));
}
const created = await request("POST", "/api/create", { name: "Pilot" });
assert.equal(created.status, 200, "Vercel adapter can create a room");
assert.match(created.data.code, /^[A-Z0-9]{4}$/);
const joined = await request("POST", "/api/join", { code: created.data.code, name: "Echo" });
assert.equal(joined.data.players?.length, 2, "second device joins shared room state");
const refreshed = await request("GET", `/api/room/${created.data.code}?token=${created.data.me.token}`);
assert.equal(refreshed.data.players.length, 2, "host poll sees the joined player without a refresh");
assert.ok(records.has("loopline:rooms:v1"), "room state is saved to Redis between serverless calls");
console.log("Vercel adapter: create, join, live roster polling, Redis persistence passed.");
