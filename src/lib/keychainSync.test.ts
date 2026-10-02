import { describe, expect, it } from "vitest";
import { planKeychainWrite } from "./keychainSync";

describe("planKeychainWrite", () => {
  it("writes a new password once, then skips unchanged saves", () => {
    const known = new Map<string, string | undefined>();
    expect(planKeychainWrite(known, "sess_1", "pw")).toBe("set");
    expect(planKeychainWrite(known, "sess_1", "pw")).toBeNull();
    expect(planKeychainWrite(known, "sess_1", "pw")).toBeNull();
  });

  it("writes again when the password changes", () => {
    const known = new Map([["sess_1", "old"]]);
    expect(planKeychainWrite(known, "sess_1", "new")).toBe("set");
    expect(known.get("sess_1")).toBe("new");
  });

  it("deletes a cleared password exactly once", () => {
    const known = new Map([["sess_1", "pw"]]);
    expect(planKeychainWrite(known, "sess_1", undefined)).toBe("delete");
    expect(planKeychainWrite(known, "sess_1", "")).toBeNull();
  });

  it("never deletes an entry it has not seen with a password", () => {
    const known = new Map<string, string | undefined>();
    expect(planKeychainWrite(known, "sess_new", undefined)).toBeNull();
    known.set("sess_nopw", undefined);
    expect(planKeychainWrite(known, "sess_nopw", undefined)).toBeNull();
  });
});
