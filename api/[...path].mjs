import { randomBytes } from "node:crypto";
process.env.LOOPLINE_TEST = "1";
const { rooms, users, handleRequest, maintainRooms } = await import("../server.mjs");
const stateKey = "loopline:rooms:v1";
const usersKey = "loopline:users:v1";
const lockKey = "loopline:rooms:write-lock:v1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
};
async function redis(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Connect an Upstash Redis database to this Vercel project first.");
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Redis request failed.");
  return data.result;
}
export default async function handler(req, res) {
  const lockToken = randomBytes(18).toString("hex");
  let locked = false;
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await redis("SET", lockKey, lockToken, "NX", "PX", "10000");
      if (result === "OK") { locked = true; break; }
      await sleep(80);
    }
    if (!locked) return json(res, 503, { error: "The timeline is busy. Try again in a moment." });

    const [snapshot, savedUsers] = await Promise.all([redis("GET", stateKey), redis("GET", usersKey)]);
    rooms.clear();
    users.clear();
    if (snapshot) {
      const savedRooms = JSON.parse(snapshot);
      for (const [code, room] of Object.entries(savedRooms)) rooms.set(code, room);
    }
    if (savedUsers) {
      const parsedUsers = JSON.parse(savedUsers);
      for (const [username, user] of Object.entries(parsedUsers)) users.set(username, user);
    }
    maintainRooms();
    await handleRequest(req, res);
    maintainRooms();
    const savedRooms = Object.fromEntries(rooms.entries());
    const persistedUsers = Object.fromEntries(users.entries());
    await Promise.all([
      redis("SET", stateKey, JSON.stringify(savedRooms), "EX", "86400"),
      redis("SET", usersKey, JSON.stringify(persistedUsers), "EX", "31536000"),
    ]);
  } catch (error) {
    if (!res.writableEnded) json(res, 503, { error: error.message || "Multiplayer storage is unavailable." });
  } finally {
    if (locked) {
      try {
        await redis("EVAL", "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", "1", lockKey, lockToken);
      } catch { /* The lock expires automatically if Redis is temporarily unavailable. */ }
    }
  }
}
