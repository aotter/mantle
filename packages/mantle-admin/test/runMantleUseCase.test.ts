import { describe, expect, it, vi } from "vitest";
import {
  DiagnosticError,
  runtimeDiagnostic,
} from "@aotter/mantle-spec";
import { runMantleUseCase } from "../src/index.js";

describe("runMantleUseCase", () => {
  it("returns successful values as JSON", async () => {
    const response = await runMantleUseCase("GET /custom", () => ({ ok: true }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("redacts thrown diagnostics and uses the shared status mapping", async () => {
    const response = await runMantleUseCase("POST /custom", () => {
      throw new DiagnosticError(runtimeDiagnostic({
        code: "INPUT_VALIDATION_FAILED",
        severity: "error",
        path: "custom/input",
        candidates: ["private-field"],
        message: "Invalid input.",
      }));
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      diagnostic: expect.not.objectContaining({ candidates: expect.anything() }),
    });
  });

  it("maps returned use-case failures instead of sending HTTP 200", async () => {
    const response = await runMantleUseCase("GET /custom", () => ({
      ok: false as const,
      diagnostic: runtimeDiagnostic({
        code: "AUTH_DENIED",
        severity: "error",
        path: "custom/auth",
        candidates: ["owner"],
        message: "Owner access required.",
      }),
    }));

    expect(response.status).toBe(403);
    const body = await response.json() as { diagnostic: Record<string, unknown> };
    expect(body.diagnostic).toMatchObject({ code: "AUTH_DENIED" });
    expect(body.diagnostic).not.toHaveProperty("candidates");
  });

  it("logs unexpected details but exposes only an internal diagnostic", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await runMantleUseCase("GET /custom", () => {
      throw new Error("D1 account secret");
    });

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("account secret");
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
