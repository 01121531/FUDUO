import { Injectable } from "@nestjs/common";

interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  name?: unknown;
}

@Injectable()
export class UpdateService {
  private cached: { expiresAt: number; value: unknown } | null = null;

  async status(refresh = false) {
    if (!refresh && this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    const repository = process.env.FUDUO_GITHUB_REPOSITORY ?? "01121531/FUDUO";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("UPDATE_REPOSITORY_INVALID");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        signal: controller.signal,
        redirect: "error",
        headers: { Accept: "application/vnd.github+json", "User-Agent": "fuduo-update-checker" },
      });
      if (!response.ok) throw new Error("UPDATE_CHECK_FAILED");
      const release = await response.json() as GithubRelease;
      const latestVersion = requiredVersion(release.tag_name);
      const currentVersion = normalizedCurrentVersion(process.env.FUDUO_VERSION ?? "0.1.0");
      const value = {
        repository,
        currentVersion,
        latestVersion,
        updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
        releaseName: typeof release.name === "string" ? release.name.slice(0, 200) : latestVersion,
        releaseUrl: requiredReleaseUrl(release.html_url, repository),
        publishedAt: typeof release.published_at === "string" ? release.published_at : null,
        deployment: {
          docker: "./deploy/update.sh --mode docker",
          source: "./deploy/update.sh --mode source",
          windowsDocker: ".\\deploy\\update.ps1 -Mode docker",
          windowsSource: ".\\deploy\\update.ps1 -Mode source",
        },
      };
      this.cached = { expiresAt: Date.now() + 10 * 60_000, value };
      return value;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("UPDATE_")) throw error;
      throw new Error("UPDATE_CHECK_FAILED");
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizedCurrentVersion(value: string) {
  const normalized = value.trim().replace(/^v?/, "v");
  return /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : "v0.0.0";
}

function requiredVersion(value: unknown) {
  if (typeof value !== "string" || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) throw new Error("UPDATE_RELEASE_INVALID");
  return value;
}

function requiredReleaseUrl(value: unknown, repository: string) {
  if (typeof value !== "string") throw new Error("UPDATE_RELEASE_INVALID");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !parsed.pathname.startsWith(`/${repository}/releases/`)) throw new Error("UPDATE_RELEASE_INVALID");
  return parsed.toString();
}

export function compareVersions(left: string, right: string) {
  const a = left.replace(/^v/, "").split(/[+-]/, 1)[0]!.split(".").map(Number);
  const b = right.replace(/^v/, "").split(/[+-]/, 1)[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
