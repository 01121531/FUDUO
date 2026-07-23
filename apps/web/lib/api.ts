import { cookies } from "next/headers";

const API_URL = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001/api";

async function userHeaders(): Promise<HeadersInit> {
  const session = (await cookies()).get("fuduo_session")?.value;
  return session ? { Cookie: `fuduo_session=${encodeURIComponent(session)}` } : {};
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { cache: "no-store", headers: await userHeaders() });
  if (!response.ok) throw new Error(`API ${response.status}`);
  const body = (await response.json()) as { success: boolean; data: T };
  if (!body.success) throw new Error("API returned failure");
  return body.data;
}

export async function apiPost<T>(path: string, data: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...await userHeaders() },
    body: JSON.stringify(data),
  });
  const body = (await response.json()) as { success: boolean; data: T; error?: { message?: string } };
  if (!response.ok || !body.success) throw new Error(body.error?.message ?? `API ${response.status}`);
  return body.data;
}
