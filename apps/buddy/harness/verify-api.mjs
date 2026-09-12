import assert from "node:assert/strict";

const origin = process.env.BUDDY_TEST_ORIGIN || "http://127.0.0.1:8790";
async function session() {
  const response = await fetch(`${origin}/api/buddy/session`);
  assert.equal(response.status, 200);
  return {
    cookie: response.headers.get("set-cookie").split(";")[0],
    snapshot: await response.json(),
  };
}
const a = await session(),
  b = await session();
assert.equal(
  a.snapshot.mode,
  "fixture",
  "API verification must use the fixture Worker to avoid inference costs.",
);
const request = (path, init = {}, cookie = a.cookie) =>
  fetch(`${origin}/api/buddy/${path}`, {
    ...init,
    headers: { ...init.headers, cookie },
  });
const fake = await request("session", {}, `o89_buddy_poc=${crypto.randomUUID()}`);
assert.equal(fake.status, 401, "a forged session ID cannot initialize an agent");
assert.equal(
  (
    await request("session", {
      headers: { origin: "https://attacker.invalid" },
    })
  ).status,
  403,
);
assert.equal(
  (
    await request("photos", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: "<svg onload='bad()'></svg>",
    })
  ).status,
  400,
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM6kAAAAASUVORK5CYII=",
  "base64",
);
const upload = await request("photos", {
  method: "POST",
  headers: { "Content-Type": "image/png", "X-Photo-Name": "fixture.png" },
  body: png,
});
assert.equal(upload.status, 200);
const photo = await upload.json();
assert.equal(
  (await request(`photos/${photo.id}`, {}, b.cookie)).status,
  404,
  "other sessions cannot read photos",
);
assert.equal((await request(`photos/${photo.id}`)).status, 200);
const turn = { id: "board", text: "My solar board", photoIds: [photo.id] };
const chat = (body) =>
  request("chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
assert.match(await (await chat(turn)).text(), /Do you also have an inverter/);
await (await chat(turn)).text();
let state = await (await request("session")).json();
assert.equal(state.messages.length, 3, "duplicate request IDs must not duplicate a turn");
assert.equal(state.installation.equipment.length, 3);
await (await chat({ ...turn, id: "wide", text: "A wider view" })).text();
await (await chat({ ...turn, id: "batteries", text: "My batteries" })).text();
state = await (await request("session")).json();
assert.equal(
  state.installation.equipment.filter((item) => item.kind === "charge-controller").length,
  1,
);
assert.equal(state.installation.equipment.find((item) => item.kind === "battery").quantity, 6);
assert.match(state.messages.at(-1).parts[0].text, /model label on one battery/);
const item = state.installation.equipment[0];
const edit = await request("equipment", {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    revision: state.installation.revision,
    id: item.id,
    name: item.name,
    brand: item.brand,
    model: "XTRA4210N",
    quantity: 1,
  }),
});
assert.equal(edit.status, 200);
assert.equal((await edit.json()).installation.equipment[0].confirmed, true);
assert.equal(
  (await (await request("session", {}, b.cookie)).json()).installation.equipment.length,
  0,
);
await request("session", { method: "DELETE" });
assert.equal((await request(`photos/${photo.id}`)).status, 404, "reset deletes the private photo");
assert.equal((await (await request("session")).json()).messages.length, 1);
console.log(
  "PASS: progressive inventory, idempotent retry, persistence, confirmation, session isolation, upload rejection and deletion.",
);
