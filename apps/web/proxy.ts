import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  if (process.env.REQUIRE_AUTH !== "true") return NextResponse.next();
  if (!request.cookies.has("fuduo_session")) {
    const login = new URL("/login", request.url);
    login.searchParams.set("returnTo", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/account-setup", "/dashboard/:path*", "/shops/:path*", "/reports/:path*", "/chat/:path*", "/sync/:path*", "/settings/:path*"],
};
