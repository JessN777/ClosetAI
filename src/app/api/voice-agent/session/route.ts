import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MossVoiceServer } from "@moss-tools/voice-server";
import { NextResponse } from "next/server";
import { getPersonalSession, withPersonalCookie } from "@/lib/personal-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseMossCredentials(content: string) {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(MOSS_PROJECT_ID|MOSS_PROJECT_KEY|MOSS_VOICE_AGENT_ID)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const raw = match[2];
    values[match[1]] = raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
      ? raw.slice(1, -1)
      : raw;
  }
  return values;
}

export async function POST(request: Request) {
  if (process.env.DEMO_OFFLINE === "1") return NextResponse.json({ error: "Moss is disabled in offline demo mode.", reason: "offline_demo" }, { status: 503 });
  const base = process.env.MOSS_VOICE_SERVICE_URL?.replace(/\/$/, "");
  if (!base) return NextResponse.json({ error: "Moss voice service is not configured.", reason: "service_url_missing" }, { status: 503 });

  const session = getPersonalSession(request);
  const respond = (body: unknown, status = 200) => withPersonalCookie(NextResponse.json(body, { status }), session.id, request);
  try {
    const healthResponse = await fetch(`${base}/health`, { cache: "no-store", signal: AbortSignal.timeout(1800) });
    if (!healthResponse.ok) return respond({ error: "Moss agent is offline.", reason: "health_unreachable" }, 503);
    const health = await healthResponse.json() as { status?: unknown; reason?: unknown; credentials_present?: unknown; agent_deployed?: unknown };
    if (health.status !== "ok" || health.credentials_present !== true || health.agent_deployed !== true) {
      return respond({ error: "Moss agent is offline.", reason: typeof health.reason === "string" ? health.reason : "not_deployed" }, 503);
    }

    const envPath = path.join(process.cwd(), "python-agent", ".env");
    const credentials = parseMossCredentials(await readFile(envPath, "utf8"));
    const missing = ["MOSS_PROJECT_ID", "MOSS_PROJECT_KEY", "MOSS_VOICE_AGENT_ID"].find((name) => !credentials[name]?.trim());
    if (missing) return respond({ error: "Moss agent credentials are missing from python-agent/.env.", reason: `missing_${missing.toLowerCase()}` }, 503);

    const voiceServer = await MossVoiceServer.create({
      projectId: credentials.MOSS_PROJECT_ID,
      projectKey: credentials.MOSS_PROJECT_KEY,
      voiceAgentId: credentials.MOSS_VOICE_AGENT_ID,
    });
    const roomName = `closetai-${randomUUID()}`;
    const participantToken = await voiceServer.createParticipantToken(
      { identity: `closet-${session.id}`, name: "ClosetAI user", metadata: JSON.stringify({ user_id: session.id }) },
      roomName,
    );
    return respond({ serverUrl: voiceServer.getServerUrl(), participantToken, roomName, agentName: voiceServer.getAgentName() });
  } catch (error) {
    console.error(JSON.stringify({ event: "moss_voice_session_create_failed", error_type: error instanceof Error ? error.name : "unknown" }));
    return respond({ error: "Moss could not start a voice session.", reason: "session_create_failed" }, 503);
  }
}
