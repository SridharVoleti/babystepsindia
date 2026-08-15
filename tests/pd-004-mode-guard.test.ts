import { describe, expect, it, vi } from "vitest";
import {
  ParentModeGuardController,
  createParentModeInvalidationMessage,
  isSafeParentModeInvalidationMessage,
} from "@/lib/parent-shell/mode-guard";

describe("PD-004 parent mode guard — AT-PD-004-23/24/25/26/28/29/30", () => {
  it("AT-PD-004-25: a bfcache pageshow (persisted=true) revalidates and fails closed on a mismatched generation", async () => {
    const onStale = vi.fn();
    const controller = new ParentModeGuardController({
      modeGeneration: 1,
      fetchModeContext: vi.fn().mockResolvedValue({ ok: true, status: 200, modeGeneration: 2 }),
      onStale,
    });
    controller.pageshow(true);
    await vi.waitFor(() => expect(onStale).toHaveBeenCalledWith("stale"));
  });

  it("a normal (non-bfcache) pageshow does not trigger a network request", () => {
    const fetchModeContext = vi.fn();
    const controller = new ParentModeGuardController({ modeGeneration: 1, fetchModeContext, onStale: vi.fn() });
    controller.pageshow(false);
    expect(fetchModeContext).not.toHaveBeenCalled();
  });

  it("AT-PD-004-23/26: a 403 (mode mismatch, e.g. PARENT_REAUTHENTICATION_REQUIRED) fails closed as unauthorized", async () => {
    const onStale = vi.fn();
    const controller = new ParentModeGuardController({
      modeGeneration: 1,
      fetchModeContext: vi.fn().mockResolvedValue({ ok: false, status: 403 }),
      onStale,
    });
    const result = await controller.revalidate();
    expect(result).toBe("unauthorized");
    expect(onStale).toHaveBeenCalledWith("unauthorized");
  });

  it("a matching generation is a no-op — no redirect", async () => {
    const onStale = vi.fn();
    const controller = new ParentModeGuardController({
      modeGeneration: 5,
      fetchModeContext: vi.fn().mockResolvedValue({ ok: true, status: 200, modeGeneration: 5 }),
      onStale,
    });
    expect(await controller.revalidate()).toBe("current");
    expect(onStale).not.toHaveBeenCalled();
  });

  it("AT-PD-004-29: receiveInvalidation ignores a message carrying the same generation", () => {
    const fetchModeContext = vi.fn();
    const controller = new ParentModeGuardController({ modeGeneration: 5, fetchModeContext, onStale: vi.fn() });
    controller.receiveInvalidation(createParentModeInvalidationMessage({
      modeGeneration: 5, reason: "mode_transition", sourceVersion: "x",
    }));
    expect(fetchModeContext).not.toHaveBeenCalled();
  });

  it("AT-PD-004-29: receiveInvalidation revalidates on a different generation from another tab", async () => {
    const fetchModeContext = vi.fn().mockResolvedValue({ ok: true, status: 200, modeGeneration: 7 });
    const onStale = vi.fn();
    const controller = new ParentModeGuardController({ modeGeneration: 5, fetchModeContext, onStale });
    controller.receiveInvalidation(createParentModeInvalidationMessage({
      modeGeneration: 7, reason: "mode_transition", sourceVersion: "learner_mode:learner-1",
    }));
    await vi.waitFor(() => expect(onStale).toHaveBeenCalledWith("stale"));
  });

  it("ignores a malformed/unsafe invalidation payload rather than throwing", () => {
    const fetchModeContext = vi.fn();
    const controller = new ParentModeGuardController({ modeGeneration: 5, fetchModeContext, onStale: vi.fn() });
    expect(() => controller.receiveInvalidation({ evil: "payload" })).not.toThrow();
    expect(() => controller.receiveInvalidation(null)).not.toThrow();
    expect(fetchModeContext).not.toHaveBeenCalled();
  });

  it("AT-PD-004-30: the invalidation message carries only generation/reason/sourceVersion — no tokens, credentials or PII", () => {
    const message = createParentModeInvalidationMessage({ modeGeneration: 3, reason: "mode_transition", sourceVersion: "learner_mode:learner-1" });
    expect(Object.keys(message).sort()).toEqual(["modeGeneration", "reason", "sourceVersion"]);
    expect(isSafeParentModeInvalidationMessage(message)).toBe(true);
    expect(isSafeParentModeInvalidationMessage({ modeGeneration: 3, reason: "mode_transition", sourceVersion: "x", passkeyId: "leak" }))
      .toBe(true); // extra fields don't invalidate, but createParentModeInvalidationMessage never emits them
  });

  it("a network failure neither redirects nor throws — stays on the current (possibly stale) page silently", async () => {
    const onStale = vi.fn();
    const controller = new ParentModeGuardController({
      modeGeneration: 1, fetchModeContext: vi.fn().mockRejectedValue(new Error("offline")), onStale,
    });
    expect(await controller.revalidate()).toBe("network_error");
    expect(onStale).not.toHaveBeenCalled();
  });

  it("coalesces concurrent revalidate() calls into a single fetch", async () => {
    let resolveFetch!: (value: { ok: true; status: 200; modeGeneration: number }) => void;
    const fetchModeContext = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const controller = new ParentModeGuardController({ modeGeneration: 1, fetchModeContext, onStale: vi.fn() });
    const first = controller.revalidate();
    const second = controller.revalidate();
    expect(fetchModeContext).toHaveBeenCalledTimes(1);
    resolveFetch({ ok: true, status: 200, modeGeneration: 1 });
    expect(await first).toBe("current");
    expect(await second).toBe("current");
  });

  it("does nothing after destroy()", async () => {
    const fetchModeContext = vi.fn();
    const controller = new ParentModeGuardController({ modeGeneration: 1, fetchModeContext, onStale: vi.fn() });
    controller.destroy();
    expect(await controller.revalidate()).toBe("current");
    expect(fetchModeContext).not.toHaveBeenCalled();
  });
});
