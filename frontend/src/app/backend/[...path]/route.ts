import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DROP_REQUEST = ["host", "connection", "content-length", "transfer-encoding"];
const DROP_RESPONSE = ["content-encoding", "content-length", "transfer-encoding"];

function apiBase(): string {
  const raw = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
  return raw.replace(/\/$/, "");
}

async function proxy(request: NextRequest, context: { params: { path: string[] } }) {
  const target = `${apiBase()}/${context.params.path.join("/")}${request.nextUrl.search}`;
  const headers = new Headers(request.headers);
  for (const name of DROP_REQUEST) headers.delete(name);

  try {
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: "no-store",
    });
    const outbound = new Headers(response.headers);
    for (const name of DROP_RESPONSE) outbound.delete(name);
    return new NextResponse(await response.arrayBuffer(), {
      status: response.status,
      headers: outbound,
    });
  } catch {
    return NextResponse.json({ detail: "upstream unavailable" }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
