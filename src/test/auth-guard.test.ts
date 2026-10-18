import { describe, expect, it } from "vitest";
import { resolveAuthRedirect, safeRedirectPath } from "@/lib/auth-guard";
import type { AuthContext } from "@/types/domain";

const signedOut: AuthContext = { configured: true, enforced: true, user: null, memberships: [], activeWorkspace: null, permissions: [], error: null };
const user = { id: "u1", email: "a@test.local", fullName: "A" };
const membership = { workspaceId: "w1", role: "Owner" as const, workspace: { id: "w1", name: "Alpha", industry: "Other", timezone: "UTC" } };

describe("resolveAuthRedirect", () => {
  it("sends signed-out visitors to login when auth is enforced, keeping the destination", () => {
    expect(resolveAuthRedirect(signedOut, "/leads", "/leads?q=x")).toEqual({ to: "/login", search: { redirect: "/leads?q=x" } });
    expect(resolveAuthRedirect(signedOut, "/login")).toBeNull();
    expect(resolveAuthRedirect(signedOut, "/auth/confirm")).toBeNull();
  });
  it("lets signed-out visitors browse in demo mode", () => {
    expect(resolveAuthRedirect({ ...signedOut, enforced: false }, "/leads")).toBeNull();
  });
  it("sends signed-in users without a workspace to onboarding", () => {
    const auth = { ...signedOut, user };
    expect(resolveAuthRedirect(auth, "/")).toEqual({ to: "/onboarding" });
    expect(resolveAuthRedirect(auth, "/onboarding")).toBeNull();
    expect(resolveAuthRedirect({ ...auth, enforced: false }, "/leads")).toEqual({ to: "/onboarding" });
  });
  it("bounces members away from auth and onboarding pages", () => {
    const auth = { ...signedOut, user, memberships: [membership], activeWorkspace: membership };
    expect(resolveAuthRedirect(auth, "/login")).toEqual({ to: "/" });
    expect(resolveAuthRedirect(auth, "/onboarding")).toEqual({ to: "/" });
    expect(resolveAuthRedirect(auth, "/leads")).toBeNull();
  });
});

describe("safeRedirectPath", () => {
  it("accepts only same-origin relative paths", () => {
    expect(safeRedirectPath("/leads")).toBe("/leads");
    expect(safeRedirectPath("//evil.example")).toBe("/");
    expect(safeRedirectPath("/\\evil.example")).toBe("/");
    expect(safeRedirectPath("https://evil.example")).toBe("/");
    expect(safeRedirectPath(undefined, "/onboarding")).toBe("/onboarding");
  });
});
