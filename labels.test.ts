import { expect, test } from "bun:test";
import { labelFor, resolveSessionLabel } from "./labels";

test("classifies request text by priority and falls back to tool names", () => {
  expect(labelFor("detect the anti bot automation for slack")).toEqual({ label: "antibot", source: "prompt" });
  expect(labelFor("can we improve this tracker thing")).toEqual({ label: "time-tracking", source: "prompt" });
  expect(labelFor("keep engaging discord continuously")).toEqual({ label: "community", source: "prompt" });
  expect(labelFor(undefined, ["beacon.navigate"])).toBeUndefined();
  expect(labelFor(undefined, ["posthog.query"])).toEqual({ label: "analytics", source: "tools" });
  expect(labelFor("hello there")).toBeUndefined();
});

test("session labels canonicalize to registry keys or stay free text", () => {
  expect(resolveSessionLabel("antibot")).toBe("antibot");
  expect(resolveSessionLabel("design system button family")).toBe("design-system");
  expect(resolveSessionLabel("random thing with no keyword")).toBe("random thing with no keyword");
});
