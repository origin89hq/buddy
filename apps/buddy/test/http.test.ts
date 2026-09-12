import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedBody, sameOrigin, validImage } from "../src/http.ts";

test("reject oversized streaming bodies even without Content-Length", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(7));
      controller.enqueue(new Uint8Array(7));
      controller.close();
    },
  });
  const request = new Request("https://example.com", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(boundedBody(request, 10), /too large/);
});
test("image validation rejects spoofed MIME and script payloads", () => {
  assert.equal(
    validImage(new TextEncoder().encode('<svg onload="evil()"></svg>'), "image/png"),
    false,
  );
  assert.equal(
    validImage(new Uint8Array([255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "image/jpeg"),
    true,
  );
});
test("cross-origin session and photo requests are rejected", () => {
  assert.equal(
    sameOrigin(
      new Request("https://origin89.com/api/buddy/session", {
        headers: { origin: "https://attacker.example" },
      }),
    ),
    false,
  );
  assert.equal(
    sameOrigin(
      new Request("https://origin89.com/api/buddy/session", {
        headers: { "sec-fetch-site": "cross-site" },
      }),
    ),
    false,
  );
  assert.equal(
    sameOrigin(
      new Request("https://origin89.com/api/buddy/session", {
        headers: { origin: "https://origin89.com" },
      }),
    ),
    true,
  );
});
