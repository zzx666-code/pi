import { describe, expect, it } from "vitest";
import { AuthError, signAuthToken, verifyAuthToken } from "../../src/agent/auth.ts";

describe("agent auth token", () => {
	it("round-trips a signed user identity", () => {
		const token = signAuthToken("user-1", "test-secret", 1_000, 3_600);

		expect(verifyAuthToken(token, "test-secret", 2_000)).toMatchObject({ userId: "user-1" });
	});

	it("rejects a token whose payload was modified", () => {
		const token = signAuthToken("user-1", "test-secret", 1_000, 3_600);
		const [header, _payload, signature] = token.split(".");
		const modifiedPayload = Buffer.from(JSON.stringify({ sub: "user-2", exp: 9_999 })).toString("base64url");

		expect(() => verifyAuthToken(`${header}.${modifiedPayload}.${signature}`, "test-secret", 2_000)).toThrow(
			AuthError,
		);
	});

	it("rejects an expired token", () => {
		const token = signAuthToken("user-1", "test-secret", 1_000, 10);

		expect(() => verifyAuthToken(token, "test-secret", 12_000)).toThrow("Authentication token has expired");
	});
});
