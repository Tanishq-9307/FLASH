// Speech input tests (M4-2): the /api/speech/transcribe route, the
// ElevenLabs Scribe provider, and the client wrapper. The provider's fetch
// is faked, so no real ElevenLabs call is made; the route's auth is faked
// through the same mocked Supabase server client the chat route tests use.
// A real voice round-trip is still untested (no live ElevenLabs key in
// this build — see PROGRESS.md).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/speech/transcribe/route";
import {
  ElevenLabsError,
  transcribeWithElevenLabs,
} from "@/lib/speech/elevenlabs";
import type { FetchLike } from "@/lib/speech/elevenlabs";
import { transcribeClip } from "@/lib/speech/transcribe-client";

// Hoisted auth state: vi.mock factories run before imports.
const testState = vi.hoisted(() => ({
  user: null as { id: string } | null,
}));

// "server-only" throws when imported outside a React Server Component
// bundle, and Vitest does not set the react-server resolve condition —
// so the real module is replaced with a no-op for these tests. The
// production guard (a build error if client code imports the provider)
// is unchanged: it is enforced by Next.js, not by this test.
vi.mock("server-only", () => ({}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        testState.user
          ? { data: { user: testState.user }, error: null }
          : { data: { user: null }, error: new Error("no session") },
    },
  }),
}));

const fetchMock = vi.fn();

function clip(size: number, type = "audio/webm"): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

function transcribeRequest(audio: Blob | string | null): Request {
  const form = new FormData();
  if (audio !== null) {
    if (typeof audio === "string") form.append("audio", audio);
    else form.append("audio", audio, "clip.webm");
  }
  return new Request("http://localhost/api/speech/transcribe", {
    method: "POST",
    body: form,
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  testState.user = { id: "user-1" };
  vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/speech/transcribe", () => {
  it("returns 401 when unauthenticated and never calls the provider", async () => {
    testState.user = null;
    const res = await POST(transcribeRequest(clip(2048)));
    expect(res.status).toBe(401);
    expect((await res.json()) as unknown).toEqual({
      error: "unauthenticated",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid-clip when the audio field is missing", async () => {
    const res = await POST(transcribeRequest(null));
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({
      error: "invalid-clip",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid-clip when audio is not a file", async () => {
    const res = await POST(transcribeRequest("not-a-file"));
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({
      error: "invalid-clip",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid-clip for a non-audio file", async () => {
    const res = await POST(transcribeRequest(clip(2048, "text/plain")));
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({
      error: "invalid-clip",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid-clip for a clip under 1 KB", async () => {
    const res = await POST(transcribeRequest(clip(512)));
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({
      error: "invalid-clip",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 413 too-large for a clip over 2 MB", async () => {
    const res = await POST(
      transcribeRequest(clip(2 * 1024 * 1024 + 1)),
    );
    expect(res.status).toBe(413);
    expect((await res.json()) as unknown).toEqual({ error: "too-large" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("transcribes a valid clip and calls ElevenLabs correctly", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "hello world" }, 200));
    const res = await POST(transcribeRequest(clip(2048)));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ text: "hello world" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.method).toBe("POST");
    expect(
      (init.headers as Record<string, string>)["xi-api-key"],
    ).toBe("test-key");
    const sent = init.body as FormData;
    expect(sent.get("model_id")).toBe("scribe_v2");
    // Language is auto-detected: no language_code is ever sent.
    expect(sent.get("language_code")).toBeNull();
    const file = sent.get("file");
    expect(file instanceof Blob).toBe(true);
    expect((file as Blob).size).toBe(2048);
  });

  it.each([402, 429])(
    "returns 429 voice-limit-reached when ElevenLabs answers %s",
    async (status) => {
      fetchMock.mockResolvedValue(jsonResponse({}, status));
      const res = await POST(transcribeRequest(clip(2048)));
      expect(res.status).toBe(429);
      expect((await res.json()) as unknown).toEqual({
        error: "voice-limit-reached",
      });
    },
  );

  it("returns 502 provider-error when ElevenLabs fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const res = await POST(transcribeRequest(clip(2048)));
    expect(res.status).toBe(502);
    expect((await res.json()) as unknown).toEqual({
      error: "provider-error",
    });
  });

  it("returns 502 provider-error when ElevenLabs is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const res = await POST(transcribeRequest(clip(2048)));
    expect(res.status).toBe(502);
    expect((await res.json()) as unknown).toEqual({
      error: "provider-error",
    });
  });

  it("returns 500 provider-misconfigured when the key is not set", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const res = await POST(transcribeRequest(clip(2048)));
    expect(res.status).toBe(500);
    expect((await res.json()) as unknown).toEqual({
      error: "provider-misconfigured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("transcribeWithElevenLabs", () => {
  it("returns the transcript text", async () => {
    const fake: FetchLike = async () => jsonResponse({ text: "hi" }, 200);
    await expect(transcribeWithElevenLabs(clip(2048), fake)).resolves.toBe(
      "hi",
    );
  });

  it("throws voice-limit-reached on 402 and 429", async () => {
    for (const status of [402, 429]) {
      const fake: FetchLike = async () => jsonResponse({}, status);
      await expect(
        transcribeWithElevenLabs(clip(2048), fake),
      ).rejects.toMatchObject({ kind: "voice-limit-reached" });
    }
  });

  it("throws provider-error when the response has no text", async () => {
    const fake: FetchLike = async () => jsonResponse({ text: 42 }, 200);
    await expect(
      transcribeWithElevenLabs(clip(2048), fake),
    ).rejects.toMatchObject({ kind: "provider-error" });
  });

  it("throws provider-misconfigured when the key is not set", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const fake: FetchLike = async () => jsonResponse({ text: "hi" }, 200);
    let caught: unknown;
    try {
      await transcribeWithElevenLabs(clip(2048), fake);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ElevenLabsError);
    expect(caught).toMatchObject({ kind: "provider-misconfigured" });
  });
});

describe("transcribeClip (client wrapper)", () => {
  it("posts the clip to the route and returns the text", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "spoken" }, 200));
    await expect(transcribeClip(clip(2048))).resolves.toBe("spoken");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/speech/transcribe");
    expect(init.method).toBe("POST");
    const sent = init.body as FormData;
    expect((sent.get("audio") as Blob).size).toBe(2048);
  });

  it("maps a 429 voice-limit-reached to the input error kind", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "voice-limit-reached" }, 429),
    );
    await expect(transcribeClip(clip(2048))).rejects.toMatchObject({
      kind: "voice-limit-reached",
    });
  });

  it("maps a 413 too-large to the input error kind", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "too-large" }, 413));
    await expect(transcribeClip(clip(2048))).rejects.toMatchObject({
      kind: "too-large",
    });
  });

  it("maps other failures to transcribe-failed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid-clip" }, 400));
    await expect(transcribeClip(clip(2048))).rejects.toMatchObject({
      kind: "transcribe-failed",
    });
  });

  it("maps a non-JSON error body to transcribe-failed", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 500 }));
    await expect(transcribeClip(clip(2048))).rejects.toMatchObject({
      kind: "transcribe-failed",
    });
  });

  it("maps a 200 without text to transcribe-failed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 200));
    await expect(transcribeClip(clip(2048))).rejects.toMatchObject({
      kind: "transcribe-failed",
    });
  });
});
