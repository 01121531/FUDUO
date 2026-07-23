import { LoginForm } from "@/components/login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const value = (await searchParams).returnTo;
  return <main className="login-page"><LoginForm returnTo={typeof value === "string" ? value : "/dashboard"} /></main>;
}
