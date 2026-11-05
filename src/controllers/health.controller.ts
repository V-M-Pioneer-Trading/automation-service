import { Controller, Extension, Get, Route, Tags } from "@tsoa/runtime";

export interface HealthStatus {
  status: "ok";
}

/**
 * Liveness. Mounted bare for local dev/compose and under /api/automation
 * because production CloudFront only routes requests matching a configured
 * path pattern. Credentials are ignored (routePolicy in auth.ts): the header
 * is never read and auth-service is never asked, so these keep answering
 * while it is down.
 */
@Route("")
@Tags("operational")
export class HealthController extends Controller {
  /** Liveness check. */
  @Extension("x-auth", "public")
  @Get("health")
  public health(): HealthStatus {
    return this.ok();
  }

  /** Liveness check on the production path prefix. */
  @Extension("x-auth", "public")
  @Get("api/automation/health")
  public apiHealth(): HealthStatus {
    return this.ok();
  }

  // Every response is live state, never cacheable.
  private ok(): HealthStatus {
    this.setHeader("Cache-Control", "no-store");
    return { status: "ok" };
  }
}
