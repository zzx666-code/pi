import { createHmac, timingSafeEqual } from "node:crypto";

export class AuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthError";
	}
}

export interface AuthIdentity {
	userId: string;
	expiresAt: number;
}

function signature(data: string, secret: string): string {
	return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signAuthToken(
	userId: string,
	secret: string,
	nowMs = Date.now(),
	expiresInSeconds = 8 * 60 * 60,
): string {
	if (!userId.trim() || !secret) throw new AuthError("User and authentication secret are required");
	const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ sub: userId, exp: Math.floor(nowMs / 1000) + expiresInSeconds }),
	).toString("base64url");
	const unsigned = `${header}.${payload}`;
	return `${unsigned}.${signature(unsigned, secret)}`;
}

export function verifyAuthToken(token: string, secret: string, nowMs = Date.now()): AuthIdentity {
	const parts = token.split(".");
	if (parts.length !== 3) throw new AuthError("Invalid authentication token");
	const [header, payload, providedSignature] = parts;
	if (!header || !payload || !providedSignature) throw new AuthError("Invalid authentication token");
	const expectedSignature = signature(`${header}.${payload}`, secret);
	const expectedBytes = Buffer.from(expectedSignature);
	const providedBytes = Buffer.from(providedSignature);
	if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) {
		throw new AuthError("Invalid authentication token signature");
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		throw new AuthError("Invalid authentication token payload");
	}
	if (!decoded || typeof decoded !== "object") throw new AuthError("Invalid authentication token payload");
	const record = decoded as Record<string, unknown>;
	if (typeof record.sub !== "string" || typeof record.exp !== "number") {
		throw new AuthError("Invalid authentication token payload");
	}
	if (record.exp <= Math.floor(nowMs / 1000)) throw new AuthError("Authentication token has expired");
	return { userId: record.sub, expiresAt: record.exp };
}
