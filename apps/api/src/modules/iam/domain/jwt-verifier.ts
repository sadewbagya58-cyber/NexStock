import {
  type JsonWebKey,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { AppError } from '../../shared/index.js';

export type AllowedAsymmetricJwtAlg = 'ES256' | 'RS256';
export type AllowedJwtAlg = AllowedAsymmetricJwtAlg | 'HS256';

export interface SupabaseJwk extends JsonWebKey {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
}

export interface SupabaseJwksDocument {
  readonly keys: readonly SupabaseJwk[];
}

export interface VerifiedJwtPrincipal {
  readonly userId: string;
  readonly email?: string | undefined;
  readonly issuer: string;
  readonly audience: string | readonly string[];
  readonly issuedAt?: number | undefined;
  readonly expiresAt: number;
  readonly notBefore?: number | undefined;
  readonly keyId?: string | undefined;
  readonly algorithm: AllowedJwtAlg;
}

export interface JwtVerificationOptions {
  /**
   * Expected `iss` claim (e.g. `https://tokylhdgzyoxiqwvncis.supabase.co/auth/v1`).
   */
  readonly expectedIssuer: string;
  /**
   * Expected `aud` claim (e.g. `authenticated`).
   */
  readonly expectedAudience: string;
  /**
   * Allowed asymmetric algorithms from JWKS. Defaults to `['ES256', 'RS256']`.
   */
  readonly allowedAlgorithms?: readonly AllowedAsymmetricJwtAlg[];
  /**
   * Clock tolerance in seconds for `nbf` / `exp` checks. Defaults to 0.
   */
  readonly clockToleranceSeconds?: number;
  /**
   * Injectable current timestamp in milliseconds for deterministic testing.
   */
  readonly nowMs?: () => number;
  /**
   * Documented Fallback for Legacy Symmetric Supabase Projects (`HS256`):
   * Modern Supabase projects (including `tokylhdgzyoxiqwvncis`) sign tokens with asymmetric `ES256`
   * published at `/auth/v1/.well-known/jwks.json`. If a legacy project has not yet rotated to asymmetric
   * keys, `legacyHs256SharedSecret` may be explicitly supplied by server config to permit `HS256`.
   * When omitted (the default), `HS256` tokens are strictly rejected to prevent algorithm-confusion attacks.
   */
  readonly legacyHs256SharedSecret?: string | undefined;
}

export interface JwksRetrievalOptions {
  readonly forceRefresh?: boolean | undefined;
}

export interface JwksKeyProvider {
  getJwks(options?: JwksRetrievalOptions): Promise<SupabaseJwksDocument>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodeBase64UrlToString(segment: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('Malformed base64url segment.');
  }
  return Buffer.from(segment, 'base64url').toString('utf-8');
}

function decodeBase64UrlToBuffer(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('Malformed base64url signature segment.');
  }
  return Buffer.from(segment, 'base64url');
}

function throwInvalidToken(detail: string, reasonCode: string): never {
  throw new AppError({
    statusCode: 401,
    errorCode: 'IAM_UNAUTHENTICATED_TOKEN',
    title: 'Unauthenticated or Invalid Bearer Token',
    detail,
    extensions: { reasonCode },
  });
}

/**
 * Remote HTTP JWKS provider with in-memory TTL caching, key-rotation refresh cooldown,
 * and request timeout handling for Supabase Auth
 * (`https://tokylhdgzyoxiqwvncis.supabase.co/auth/v1/.well-known/jwks.json`).
 */
export class RemoteJwksProvider implements JwksKeyProvider {
  private readonly jwksUrl: string;
  private readonly cacheTtlMs: number;
  private readonly minRefreshIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly nowMs: () => number;
  private cachedDoc: SupabaseJwksDocument | null = null;
  private cachedAtMs = 0;

  constructor(params: {
    readonly jwksUrl: string;
    readonly cacheTtlMs?: number;
    readonly minRefreshIntervalMs?: number;
    readonly timeoutMs?: number;
    readonly fetchFn?: typeof fetch;
    readonly nowMs?: () => number;
  }) {
    this.jwksUrl = params.jwksUrl;
    this.cacheTtlMs = params.cacheTtlMs ?? 5 * 60 * 1000;
    this.minRefreshIntervalMs = params.minRefreshIntervalMs ?? 10 * 1000;
    this.timeoutMs = params.timeoutMs ?? 5000;
    this.fetchFn = params.fetchFn ?? fetch;
    this.nowMs = params.nowMs ?? (() => Date.now());
  }

  async getJwks(options?: JwksRetrievalOptions): Promise<SupabaseJwksDocument> {
    const now = this.nowMs();
    const forceRefresh = options?.forceRefresh === true;

    if (this.cachedDoc) {
      const ageMs = now - this.cachedAtMs;
      if (!forceRefresh && ageMs < this.cacheTtlMs) {
        return this.cachedDoc;
      }
      // Cooldown protection: if forceRefresh was requested on an unknown kid,
      // avoid hammering the upstream JWKS endpoint if we just refreshed recently.
      if (forceRefresh && ageMs < this.minRefreshIntervalMs) {
        return this.cachedDoc;
      }
    }

    let response: Response;
    try {
      response = await this.fetchFn(this.jwksUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AppError({
        statusCode: 500,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'JWKS Discovery Network or Timeout Error',
        detail:
          err instanceof Error
            ? `JWKS retrieval failed: ${err.message}`
            : 'JWKS retrieval failed due to a network or timeout error.',
        extensions: { reasonCode: 'JWKS_FETCH_TIMEOUT_OR_NETWORK_ERROR' },
      });
    }

    if (!response.ok) {
      throw new AppError({
        statusCode: 500,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'JWKS Discovery Failure',
        detail: `Failed to fetch JWKS from configured endpoint (HTTP ${String(response.status)}).`,
        extensions: { reasonCode: 'JWKS_HTTP_ERROR' },
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AppError({
        statusCode: 500,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'Invalid JWKS JSON Response',
        detail: 'JWKS endpoint returned malformed JSON.',
        extensions: { reasonCode: 'JWKS_INVALID_JSON' },
      });
    }

    if (
      typeof payload !== 'object' ||
      payload === null ||
      !Array.isArray((payload as { keys?: unknown }).keys) ||
      (payload as { keys: unknown[] }).keys.length === 0
    ) {
      throw new AppError({
        statusCode: 500,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'Invalid JWKS Payload',
        detail:
          'JWKS endpoint did not return a non-empty RFC 7517 keys array.',
        extensions: { reasonCode: 'JWKS_EMPTY_OR_INVALID_KEYS' },
      });
    }

    this.cachedDoc = payload as SupabaseJwksDocument;
    this.cachedAtMs = now;
    return this.cachedDoc;
  }
}

/**
 * Static in-memory JWKS provider for deterministic unit/integration testing or pinned keys.
 */
export class StaticJwksProvider implements JwksKeyProvider {
  private readonly doc: SupabaseJwksDocument;

  constructor(doc: SupabaseJwksDocument) {
    this.doc = doc;
  }

  async getJwks(): Promise<SupabaseJwksDocument> {
    return this.doc;
  }
}

function findMatchingJwk(
  jwks: SupabaseJwksDocument,
  alg: AllowedAsymmetricJwtAlg,
  kid: string | undefined,
): SupabaseJwk | undefined {
  const expectedKty = alg === 'ES256' ? 'EC' : 'RSA';
  return jwks.keys.find((k) => {
    if (k.kty !== expectedKty) return false;
    if (kid && k.kid && k.kid !== kid) return false;
    if (k.alg && k.alg !== alg) return false;
    return true;
  });
}

/**
 * Verifies a Bearer JWT token against Supabase JWKS (`ES256`/`RS256`) and strict claim invariants.
 *
 * Security Invariants (NEX-DOC-05 & NEX-DOC-06):
 * 1. Rejects missing, malformed, or non-3-part JWS tokens.
 * 2. Enforces algorithm allowlist (`ES256`, `RS256`; `HS256` only when legacy fallback is explicitly configured).
 *    Strictly rejects `alg: "none"` and prevents RSA/EC-to-HMAC key confusion.
 * 3. Verifies cryptographic signature using Node's native `node:crypto` against the matching JWK (`kid` + `kty`).
 *    Automatically triggers a rate-limited JWKS refresh (`forceRefresh: true`) if a newly rotated `kid` is encountered.
 * 4. Validates `iss`, `aud`, `exp`, `nbf`, and `sub` (UUID).
 * 5. Never trusts client-supplied `role`, `tenant_id`, or `app_metadata` claims for tenant/permission authority;
 *    only extracts the verified `sub` (`userId`) and optional `email`.
 */
export async function verifySupabaseJwt(
  authorizationHeaderOrToken: string | undefined,
  jwksProvider: JwksKeyProvider,
  options: JwtVerificationOptions,
): Promise<VerifiedJwtPrincipal> {
  if (!authorizationHeaderOrToken || authorizationHeaderOrToken.trim() === '') {
    throwInvalidToken('Missing Authorization Bearer token.', 'MISSING_TOKEN');
  }

  const raw = authorizationHeaderOrToken.trim();
  const token = raw.toLowerCase().startsWith('bearer ')
    ? raw.slice(7).trim()
    : raw;

  const segments = token.split('.');
  if (segments.length !== 3) {
    throwInvalidToken(
      'Malformed JWT: expected 3 dot-separated base64url segments.',
      'MALFORMED_JWT',
    );
  }

  const [headerSeg, payloadSeg, signatureSeg] = segments as [
    string,
    string,
    string,
  ];
  if (!headerSeg || !payloadSeg || !signatureSeg) {
    throwInvalidToken(
      'Malformed JWT: empty header, payload, or signature segment.',
      'MALFORMED_JWT',
    );
  }

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  let signatureBuffer: Buffer;

  try {
    header = JSON.parse(decodeBase64UrlToString(headerSeg)) as Record<
      string,
      unknown
    >;
    payload = JSON.parse(decodeBase64UrlToString(payloadSeg)) as Record<
      string,
      unknown
    >;
    signatureBuffer = decodeBase64UrlToBuffer(signatureSeg);
  } catch {
    throwInvalidToken(
      'Malformed JWT: failed to decode base64url JSON header or payload.',
      'MALFORMED_JWT',
    );
  }

  const alg = header['alg'];
  const kid = typeof header['kid'] === 'string' ? header['kid'] : undefined;
  const allowedAsymmetric = options.allowedAlgorithms ?? ['ES256', 'RS256'];

  if (typeof alg !== 'string' || alg.toLowerCase() === 'none') {
    throwInvalidToken(
      'Disallowed or missing JWT signing algorithm.',
      'DISALLOWED_ALGORITHM',
    );
  }

  const signingInput = Buffer.from(`${headerSeg}.${payloadSeg}`, 'utf-8');

  if (alg === 'HS256') {
    if (!options.legacyHs256SharedSecret) {
      throwInvalidToken(
        'Symmetric HS256 algorithm is disabled; asymmetric JWKS (ES256/RS256) is required.',
        'DISALLOWED_ALGORITHM',
      );
    }
    const expectedMac = createHmac('sha256', options.legacyHs256SharedSecret)
      .update(signingInput)
      .digest();
    if (
      expectedMac.length !== signatureBuffer.length ||
      !timingSafeEqual(expectedMac, signatureBuffer)
    ) {
      throwInvalidToken('Invalid JWT HMAC signature.', 'INVALID_SIGNATURE');
    }
  } else if (
    allowedAsymmetric.includes(alg as AllowedAsymmetricJwtAlg) &&
    (alg === 'ES256' || alg === 'RS256')
  ) {
    let jwks = await jwksProvider.getJwks();
    let matchingKey = findMatchingJwk(jwks, alg, kid);

    // If a key rotation occurred upstream, retry once with forceRefresh=true
    if (!matchingKey && kid) {
      jwks = await jwksProvider.getJwks({ forceRefresh: true });
      matchingKey = findMatchingJwk(jwks, alg, kid);
    }

    if (!matchingKey) {
      throwInvalidToken(
        `No matching JWK found in JWKS for alg="${alg}" and kid="${kid ?? 'unspecified'}".`,
        'UNKNOWN_JWK_KID',
      );
    }

    let isSignatureValid = false;
    try {
      const publicKey = createPublicKey({
        key: matchingKey,
        format: 'jwk',
      });

      if (alg === 'ES256') {
        // JWS ES256 uses 64-byte IEEE P1363 (r || s) encoding
        isSignatureValid = verify(
          'sha256',
          signingInput,
          { key: publicKey, dsaEncoding: 'ieee-p1363' },
          signatureBuffer,
        );
      } else {
        isSignatureValid = verify(
          'sha256',
          signingInput,
          publicKey,
          signatureBuffer,
        );
      }
    } catch {
      isSignatureValid = false;
    }

    if (!isSignatureValid) {
      throwInvalidToken(
        'Cryptographic JWT signature verification failed.',
        'INVALID_SIGNATURE',
      );
    }
  } else {
    throwInvalidToken(
      `Unsupported JWT algorithm "${alg}". Allowed: [${allowedAsymmetric.join(', ')}].`,
      'DISALLOWED_ALGORITHM',
    );
  }

  // Validate standard claims: iss, aud, exp, nbf, sub
  const nowSeconds = Math.floor(
    (options.nowMs ? options.nowMs() : Date.now()) / 1000,
  );
  const tolerance = options.clockToleranceSeconds ?? 0;

  const iss = payload['iss'];
  if (typeof iss !== 'string' || iss !== options.expectedIssuer) {
    throwInvalidToken(
      `Invalid JWT issuer "${String(iss)}"; expected "${options.expectedIssuer}".`,
      'INVALID_ISSUER',
    );
  }

  const aud = payload['aud'];
  const audMatches =
    (typeof aud === 'string' && aud === options.expectedAudience) ||
    (Array.isArray(aud) && aud.includes(options.expectedAudience));
  if (!audMatches) {
    throwInvalidToken(
      `Invalid JWT audience; expected "${options.expectedAudience}".`,
      'INVALID_AUDIENCE',
    );
  }

  const exp = payload['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throwInvalidToken('Missing or invalid JWT "exp" claim.', 'MISSING_EXP');
  }
  if (nowSeconds > exp + tolerance) {
    throwInvalidToken('JWT token has expired.', 'TOKEN_EXPIRED');
  }

  const nbf = payload['nbf'];
  if (nbf !== undefined) {
    if (typeof nbf !== 'number' || !Number.isFinite(nbf)) {
      throwInvalidToken('Invalid JWT "nbf" claim.', 'INVALID_NBF');
    }
    if (nowSeconds + tolerance < nbf) {
      throwInvalidToken(
        'JWT token is not yet valid (nbf).',
        'TOKEN_NOT_YET_VALID',
      );
    }
  }

  const iat =
    typeof payload['iat'] === 'number' && Number.isFinite(payload['iat'])
      ? payload['iat']
      : undefined;

  const sub = payload['sub'];
  if (typeof sub !== 'string' || !UUID_REGEX.test(sub)) {
    throwInvalidToken(
      'Invalid or missing JWT "sub" subject UUID claim.',
      'INVALID_SUBJECT',
    );
  }

  const email =
    typeof payload['email'] === 'string' && payload['email'].length > 0
      ? payload['email']
      : undefined;

  return {
    userId: sub,
    email,
    issuer: iss,
    audience: aud as string | readonly string[],
    issuedAt: iat,
    expiresAt: exp,
    notBefore: typeof nbf === 'number' ? nbf : undefined,
    keyId: kid,
    algorithm: alg as AllowedJwtAlg,
  };
}
