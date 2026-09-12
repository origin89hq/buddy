import { DurableObject } from "cloudflare:workers";
import {
  type EquipmentEdit,
  editSchema,
  type Installation,
  mergeExtraction,
  newInstallation,
  nextQuestion,
  observationReply,
  type Photo,
  type SavedMessage,
  type SessionSnapshot,
  type Turn,
  turnSchema,
} from "@origin89/buddy";
import { fixtureRounds } from "@origin89/buddy/fixtures";
import { Agent, getAgentByName } from "agents";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { converse } from "./conversation";
import { boundedBody, HttpError, sameOrigin, validImage } from "./http";
import { extract } from "./inference";
import { citedSources, previewKnowledge, retrieveKnowledge } from "./knowledge";
import { solarChecks } from "./solar-checks";

const cookieName = "o89_buddy_poc";
const day = 86_400_000;
type RecordState = {
  installation: Installation;
  messages: SavedMessage[];
  photos: Photo[];
  pending: { id: string; started: number } | null;
  created: number;
  attempts: number;
  fixtureRound: number;
};
function initial(): RecordState {
  return {
    installation: newInstallation(),
    messages: [
      {
        id: "welcome",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "Got a photo of your setup? A wide shot is a great place to start.",
          },
        ],
      },
    ],
    photos: [],
    pending: null,
    created: 0,
    attempts: 0,
    fixtureRound: 0,
  };
}

// The shared object only reserves small preview budgets. Conversation work stays in separate agents.
export class PreviewBudget extends DurableObject<Env> {
  async reserve(kind: "sessions" | "uploads" | "inference", amount = 1) {
    const key = `${Math.floor(Date.now() / day)}:${kind}`;
    const limits = { sessions: 30, uploads: 100, inference: 40 };
    return this.ctx.storage.transaction(async (txn) => {
      const used = (await txn.get<number>(key)) ?? 0;
      if (used + amount > limits[kind]) return false;
      await txn.put(key, used + amount);
      return true;
    });
  }
}

export class BuddySession extends Agent<Env, RecordState> {
  initialState = initial();
  private assertIdle() {
    if (this.state.pending && Date.now() - this.state.pending.started < 90_000)
      throw new HttpError(
        409,
        "Buddy is still reading your previous message. Please wait a moment.",
      );
  }
  async initialize() {
    if (this.state.created) return;
    this.setState({ ...initial(), created: Date.now() });
    await this.schedule(7 * 24 * 60 * 60, "expireSession");
  }
  isActive() {
    return this.state.created > 0 && Date.now() - this.state.created < 7 * day;
  }
  snapshot(): SessionSnapshot {
    const messages = structuredClone(this.state.messages);
    const last = messages.findLast((message) => message.role === "assistant");
    if (last) {
      // Calculations belong to the revision on which they were made. A later
      // identity edit must not relabel historical checks as current results.
      if (
        last.metadata?.installation.revision !== this.state.installation.revision &&
        last.metadata
      )
        delete last.metadata.solarChecks;
      last.metadata = { ...last.metadata, installation: this.state.installation };
    }
    return {
      installation: this.state.installation,
      messages,
      photos: this.state.photos,
      mode: this.env.BUDDY_MODE === "fixture" ? "fixture" : "live",
      aiProvider: this.env.BUDDY_MODEL.startsWith("openai/") ? "OpenAI" : "Cloudflare AI",
      pending: !!this.state.pending && Date.now() - this.state.pending.started < 90_000,
    };
  }
  async upload(bytes: Uint8Array, mediaType: string, name: string): Promise<Photo> {
    this.assertIdle();
    if (this.state.photos.length >= 24)
      throw new HttpError(
        400,
        "This preview holds up to 24 photos. Download your record before starting again.",
      );
    // Reserve a record before R2 I/O so simultaneous uploads cannot bypass the limit.
    const id = crypto.randomUUID();
    const photo: Photo = {
      id,
      name,
      mediaType,
      url: `/api/buddy/photos/${id}`,
    };
    this.setState({
      ...this.state,
      photos: [...this.state.photos, photo],
      pending: { id, started: Date.now() },
    });
    try {
      await this.env.PHOTOS.put(`${this.name}/${id}`, bytes, {
        httpMetadata: { contentType: mediaType },
      });
    } catch (error) {
      this.setState({
        ...this.state,
        photos: this.state.photos.filter((item) => item.id !== id),
        pending: null,
      });
      throw error;
    }
    this.setState({ ...this.state, pending: null });
    return photo;
  }
  async photo(id: string): Promise<Response> {
    if (!this.state.photos.some((photo) => photo.id === id))
      return new Response(null, { status: 404 });
    const object = await this.env.PHOTOS.get(`${this.name}/${id}`);
    return object
      ? new Response(object.body, {
          headers: {
            "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        })
      : new Response(null, { status: 404 });
  }
  async turn(input: Turn): Promise<SavedMessage> {
    const saved = this.state.messages.find((message) => message.id === `reply:${input.id}`);
    if (saved)
      return { ...saved, metadata: { ...saved.metadata, installation: this.state.installation } };
    this.assertIdle();
    if (this.state.attempts >= 40 || this.state.messages.length >= 81)
      throw new HttpError(
        429,
        "This conversation has reached the preview limit. Download your record to keep it.",
      );
    const photos = input.photoIds.map((id) => this.state.photos.find((photo) => photo.id === id));
    if (photos.some((photo) => !photo))
      throw new HttpError(
        400,
        "One of those photos is not in this conversation. Please attach it again.",
      );
    const before = this.state.installation;
    this.setState({
      ...this.state,
      pending: { id: input.id, started: Date.now() },
      attempts: this.state.attempts + 1,
    });
    try {
      let installation = structuredClone(before);
      let fixtureRound = this.state.fixtureRound;
      let conversationalReply: string | undefined;
      let sources: NonNullable<SavedMessage["metadata"]>["sources"] = [];
      const question = nextQuestion(installation);
      if (input.action === "defer" && question) {
        installation.deferred.push(question.id);
        installation.revision++;
      } else if (input.action === "absent" && question?.kind) {
        installation.absent = [...new Set([...installation.absent, question.kind])];
        installation.revision++;
      } else {
        if (this.env.BUDDY_MODE === "fixture") {
          installation = mergeExtraction(
            before,
            fixtureRounds[Math.min(fixtureRound, 2)],
            input.id,
            input.photoIds,
          );
          fixtureRound++;
        } else {
          const calls = /@cf\/(moondream|llava-hf)\//.test(this.env.BUDDY_MODEL)
            ? Math.max(1, photos.length)
            : 1;
          if (!(await this.env.BUDGET.getByName("preview").reserve("inference", calls)))
            throw new HttpError(
              429,
              "The preview’s daily AI budget is used. Your setup is saved; try again tomorrow.",
            );
          const images = [];
          for (const photo of photos) {
            if (!photo) continue;
            const object = await this.env.PHOTOS.get(`${this.name}/${photo.id}`);
            if (!object)
              throw new HttpError(
                400,
                "That photo is no longer available. Please attach it again.",
              );
            images.push({
              bytes: new Uint8Array(await object.arrayBuffer()),
              mediaType: photo.mediaType,
            });
          }
          if (images.length) {
            installation = mergeExtraction(
              before,
              await extract(this.env, before, input.text, images),
              input.id,
              input.photoIds,
            );
          } else {
            const response = await converse(
              this.env,
              before,
              this.state.messages,
              input.text,
              undefined,
              {
                beforeStep: async (stepNumber) => {
                  // The first call is reserved above. Every additional model
                  // round consumes the same daily budget, including the answer.
                  if (
                    stepNumber > 0 &&
                    !(await this.env.BUDGET.getByName("preview").reserve("inference"))
                  )
                    throw new HttpError(
                      429,
                      "The preview’s daily AI budget is used. Your setup is saved; try again tomorrow.",
                    );
                },
              },
            );
            installation = mergeExtraction(before, response.extraction, input.id, []);
            conversationalReply = response.reply;
            sources = response.sources;
          }
        }
      }
      if (installation.equipment.length > 40)
        throw new HttpError(400, "This preview holds up to 40 equipment entries.");
      const knowledge = installation.solarArrays?.length
        ? await retrieveKnowledge(this.env.KNOWLEDGE, installation, "")
        : { status: "no-match" as const, records: [], truncated: false };
      const checks = solarChecks(installation, knowledge);
      const checkSources = citedSources(
        knowledge,
        checks.flatMap((check) => check.sourceIds),
      );
      sources = [
        ...new Map(
          [...(sources ?? []), ...checkSources].map((source) => [source.id, source]),
        ).values(),
      ];
      const reply: SavedMessage = {
        id: `reply:${input.id}`,
        role: "assistant",
        metadata: { installation, sources, solarChecks: checks },
        parts: [
          {
            type: "text",
            text: conversationalReply ?? observationReply(before, installation, photos.length),
          },
        ],
      };
      const user: SavedMessage = {
        id: input.id,
        role: "user",
        parts: [
          ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
          ...photos.flatMap((photo) =>
            photo
              ? [
                  {
                    type: "file" as const,
                    mediaType: photo.mediaType,
                    filename: photo.name,
                    url: photo.url,
                  },
                ]
              : [],
          ),
        ],
      };
      this.setState({
        ...this.state,
        installation,
        messages: [...this.state.messages, user, reply],
        pending: null,
        fixtureRound,
      });
      return reply;
    } catch (error) {
      this.setState({ ...this.state, pending: null });
      // Do not log photos, model output, prompt contents or vendor response bodies.
      console.error(
        JSON.stringify({
          event: "buddy_turn_failed",
          error: error instanceof Error ? error.name : "Unknown",
        }),
      );
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        "Buddy couldn’t read that just now. Your saved setup is unchanged. Please retry, or add a clearer photo.",
      );
    }
  }
  edit(input: EquipmentEdit): SessionSnapshot {
    this.assertIdle();
    if (input.revision !== this.state.installation.revision)
      throw new HttpError(409, "Your setup changed. Refresh before editing this card.");
    const installation = structuredClone(this.state.installation);
    const item = installation.equipment.find((item) => item.id === input.id);
    if (!item) throw new HttpError(404, "Equipment not found.");
    Object.assign(item, {
      name: input.name,
      brand: input.brand || null,
      model: input.model || null,
      quantity: input.quantity,
      confirmed: true,
    });
    installation.revision++;
    this.setState({ ...this.state, installation });
    return this.snapshot();
  }
  async clear(): Promise<SessionSnapshot> {
    this.assertIdle();
    this.setState({
      ...this.state,
      pending: { id: "clear", started: Date.now() },
    });
    try {
      await this.env.PHOTOS.delete(this.state.photos.map((photo) => `${this.name}/${photo.id}`));
      this.setState({
        ...initial(),
        created: this.state.created,
        attempts: this.state.attempts,
      });
    } catch (error) {
      this.setState({ ...this.state, pending: null });
      throw error;
    }
    return this.snapshot();
  }
  async expireSession() {
    await this.env.PHOTOS.delete(this.state.photos.map((photo) => `${this.name}/${photo.id}`));
    this.setState(initial());
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    // This worker has no public route and serves no assets. Everything reaches
    // it through the website's service binding, which forwards only
    // `/api/buddy/*`; anything else arriving here is a caller's mistake, and
    // answering it with a page would hide that.
    if (!path.startsWith("/api/buddy/")) return new Response("Not found", { status: 404 });
    try {
      if (!sameOrigin(request))
        throw new HttpError(403, "Open Buddy from the same website to continue.");
      const mode = env.BUDDY_MODE === "fixture" ? "fixture" : "live";
      if (path === "/api/buddy/status" && request.method === "GET")
        return Response.json({ mode }, { headers: { "Cache-Control": "no-store" } });
      let sessionId = request.headers
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      let setCookie: string | undefined;
      if (
        !sessionId ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(sessionId)
      ) {
        if (path !== "/api/buddy/session" || request.method !== "GET")
          throw new HttpError(401, "Open a Buddy conversation first.");
        if (!(await env.BUDGET.getByName("preview").reserve("sessions")))
          throw new HttpError(
            429,
            "The preview’s daily session limit is reached. Please try again tomorrow.",
          );
        sessionId = crypto.randomUUID();
        setCookie = `${cookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/api/buddy; Max-Age=604800${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
      }
      const session = await getAgentByName(env.SESSIONS, sessionId);
      if (setCookie) await session.initialize();
      else if (!(await session.isActive()))
        return Response.json(
          {
            error: "This preview session has expired. Reload to start a new setup.",
          },
          {
            status: 401,
            headers: {
              "Set-Cookie": `${cookieName}=; HttpOnly; SameSite=Strict; Path=/api/buddy; Max-Age=0`,
              "Cache-Control": "no-store",
            },
          },
        );
      let response: Response;
      if (path === "/api/buddy/session" && request.method === "GET")
        response = Response.json(await session.snapshot());
      else if (path === "/api/buddy/session" && request.method === "DELETE")
        response = Response.json(await session.clear());
      else if (path === "/api/buddy/equipment" && request.method === "PATCH") {
        const input = editSchema.parse(
          JSON.parse(new TextDecoder().decode(await boundedBody(request, 8000))),
        );
        response = Response.json(await session.edit(input));
      } else if (path === "/api/buddy/photos" && request.method === "POST") {
        const bytes = await boundedBody(request, 3 * 1024 * 1024);
        const mediaType = request.headers.get("content-type") ?? "";
        if (!validImage(bytes, mediaType))
          throw new HttpError(400, "Use a readable JPG, PNG or WebP photo.");
        if (!(await env.BUDGET.getByName("preview").reserve("uploads")))
          throw new HttpError(429, "The preview’s daily photo limit is reached.");
        const name = decodeURIComponent(
          request.headers.get("x-photo-name") ?? "Installation photo",
        ).slice(0, 160);
        response = Response.json(await session.upload(bytes, mediaType, name));
      } else if (/^\/api\/buddy\/photos\/[a-f0-9-]{36}$/.test(path) && request.method === "GET")
        response = await session.photo(path.split("/").at(-1)!);
      else if (path === "/api/buddy/chat" && request.method === "POST") {
        const input = turnSchema.parse(
          JSON.parse(new TextDecoder().decode(await boundedBody(request, 12000))),
        );
        const stream = createUIMessageStream({
          execute: async ({ writer }) => {
            if (
              input.action === "message" &&
              input.text &&
              !input.photoIds.length &&
              env.BUDDY_MODE !== "fixture"
            ) {
              const preview = await previewKnowledge(env.KNOWLEDGE, input.text);
              if (preview.records.length)
                writer.write({ type: "data-knowledge", data: preview, transient: true });
            }
            const reply = await session.turn(input);
            writer.write({
              type: "start",
              messageId: reply.id,
              messageMetadata: reply.metadata,
            });
            writer.write({ type: "text-start", id: reply.id });
            for (const part of reply.parts)
              if (part.type === "text")
                writer.write({
                  type: "text-delta",
                  id: reply.id,
                  delta: part.text,
                });
            writer.write({ type: "text-end", id: reply.id });
            writer.write({ type: "finish", finishReason: "stop" });
          },
          onError: (error) =>
            error instanceof Error
              ? error.message
              : "Buddy couldn’t finish that reply. Please retry.",
        });
        response = createUIMessageStreamResponse({ stream });
      } else throw new HttpError(404, "Buddy endpoint not found.");
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "private, no-store");
      headers.set("X-Content-Type-Options", "nosniff");
      if (setCookie) headers.set("Set-Cookie", setCookie);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      return Response.json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : "That request could not be processed. Please refresh and try again.",
        },
        { status, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
