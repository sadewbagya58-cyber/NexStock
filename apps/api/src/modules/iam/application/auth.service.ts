import type {
  AuthUserSummary,
  LoginRequest,
  LoginResponse,
  PasswordResetRequest,
  RefreshTokenRequest,
  SignUpRequest,
  SignUpResponse,
  TenantMembershipSummary,
  UserMeResponse,
} from '@nexstock/contracts';
import { type Kysely, sql } from 'kysely';
import {
  AppError,
  type NexStockDatabase,
  generateUuidV7,
  sanitizeLogMessage,
  withAppUserTransaction,
  withUserTransaction,
} from '../../shared/index.js';
import {
  DEFAULT_SUPABASE_URL,
  signDevJwt,
} from '../domain/jwt-verifier.js';
import {
  SYSTEM_ROLE_DEFINITIONS,
  type SystemRoleCode,
} from '../domain/system-roles.js';

export interface AuthServiceConfig {
  readonly supabaseUrl?: string | undefined;
  readonly supabaseAnonKey?: string | undefined;
  readonly isDevOrTestMode?: boolean | undefined;
}

export function isProductionEnvironment(config: AuthServiceConfig): boolean {
  if (config.isDevOrTestMode === false) return true;
  if (config.isDevOrTestMode === true) return false;
  return Boolean(process.env['APP_DATABASE_URL']);
}

interface SupabaseAuthErrorBody {
  readonly error?: string | undefined;
  readonly error_description?: string | undefined;
  readonly msg?: string | undefined;
  readonly message?: string | undefined;
  readonly code?: string | number | undefined;
}

interface SupabaseUserResponse {
  readonly id: string;
  readonly email?: string | undefined;
  readonly user_metadata?: {
    readonly full_name?: string | undefined;
    readonly name?: string | undefined;
  } | undefined;
}

interface SupabaseSessionResponse {
  readonly access_token?: string | undefined;
  readonly refresh_token?: string | undefined;
  readonly expires_in?: number | undefined;
  readonly user?: SupabaseUserResponse | undefined;
  readonly id?: string | undefined;
  readonly email?: string | undefined;
  readonly user_metadata?: {
    readonly full_name?: string | undefined;
  } | undefined;
}

/**
 * Ensures user record exists in `public.users` table so foreign keys and memberships
 * link cleanly.
 */
export async function ensureUserRecordDirect(
  db: Kysely<NexStockDatabase>,
  input: {
    readonly userId: string;
    readonly email: string;
    readonly fullName: string;
  },
  traceId?: string,
): Promise<void> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const trimmedName = input.fullName.trim() || normalizedEmail.split('@')[0] || 'User';

  await withAppUserTransaction(
    db,
    { userId: input.userId, traceId },
    async (trx) => {
      const existing = await trx
        .selectFrom('users')
        .select(['id', 'email', 'full_name'])
        .where((eb) =>
          eb.or([
            eb('id', '=', input.userId),
            eb('email', '=', normalizedEmail),
          ]),
        )
        .executeTakeFirst();

      if (!existing) {
        await trx
          .insertInto('users')
          .values({
            id: input.userId,
            email: normalizedEmail,
            full_name: trimmedName,
            is_platform_admin: false,
          })
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
      } else if (existing.id === input.userId) {
        // User already synced; update full_name if existing was placeholder
        if ((!existing.full_name || existing.full_name === normalizedEmail) && trimmedName) {
          await trx
            .updateTable('users')
            .set({
              full_name: trimmedName,
              updated_at: sql`clock_timestamp()`,
            })
            .where('id', '=', input.userId)
            .execute();
        }
      } else if (existing.email === normalizedEmail && existing.id !== input.userId) {
        // Collision: email already registered under a different user identifier
        throw new AppError({
          statusCode: 409,
          errorCode: 'AUTH_EMAIL_ALREADY_EXISTS',
          title: 'Email Already Registered',
          detail: 'An account with this email address already exists. Please log in instead.',
        });
      }
    },
  );
}

/**
 * Handles User Registration (Sign Up) via Supabase Auth or local dev fallback.
 */
export async function handleSignUp(
  db: Kysely<NexStockDatabase>,
  config: AuthServiceConfig,
  input: SignUpRequest,
  traceId?: string,
): Promise<SignUpResponse> {
  const currentTraceId = traceId ?? `req_${generateUuidV7()}`;
  const normalizedEmail = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();

  if (input.password.length < 8) {
    throw new AppError({
      statusCode: 400,
      errorCode: 'AUTH_WEAK_PASSWORD',
      title: 'Weak Password',
      detail: 'Password must be at least 8 characters long.',
    });
  }

  const supabaseUrl = config.supabaseUrl ?? process.env['SUPABASE_URL'] ?? DEFAULT_SUPABASE_URL;
  const anonKey = config.supabaseAnonKey ?? process.env['SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_PUBLISHABLE_KEY'];

  // Check if live Supabase auth key is required but missing in production
  if (isProductionEnvironment(config) && (!anonKey || anonKey === 'SET_IN_LOCAL_ENV')) {
    console.error('[NexStock Auth Configuration Error]', {
      traceId: currentTraceId,
      error: 'SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY) is missing in production environment.',
    });
    throw new AppError({
      statusCode: 503,
      errorCode: 'ERR_INTERNAL_SERVER_ERROR',
      title: 'Authentication Service Not Configured',
      detail: 'Supabase authentication is not configured in this environment. Set SUPABASE_ANON_KEY in Render environment variables.',
    });
  }

  // Check local database for pre-existing email using safe app user transaction
  const existingUser = await withAppUserTransaction(
    db,
    { traceId: currentTraceId },
    async (trx) => {
      return trx
        .selectFrom('users')
        .select('id')
        .where('email', '=', normalizedEmail)
        .executeTakeFirst();
    },
  );

  if (existingUser) {
    throw new AppError({
      statusCode: 409,
      errorCode: 'AUTH_EMAIL_ALREADY_EXISTS',
      title: 'Email Already Registered',
      detail: 'An account with this email address already exists. Please log in instead.',
    });
  }

  // If live Supabase anon key is provided, delegate to GoTrue REST API
  if (anonKey && anonKey !== 'SET_IN_LOCAL_ENV') {
    let resp: Response;
    try {
      resp = await fetch(`${supabaseUrl}/auth/v1/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          email: normalizedEmail,
          password: input.password,
          data: {
            full_name: fullName,
          },
        }),
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      const safeDetail = sanitizeLogMessage(err instanceof Error ? err.message : String(err));
      console.error('[NexStock Auth Provider Failure]', {
        traceId: currentTraceId,
        operation: 'signup',
        errorName: err instanceof Error ? err.name : typeof err,
        detail: safeDetail,
      });
      throw new AppError({
        statusCode: 502,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'Authentication Service Unavailable',
        detail: `Failed to communicate with authentication provider: ${safeDetail}`,
      });
    }

    const data = (await resp.json()) as SupabaseSessionResponse & SupabaseAuthErrorBody;

    if (!resp.ok) {
      const errorMsg = data.msg ?? data.message ?? data.error_description ?? data.error ?? 'Registration failed.';
      const safeSupabaseCode = data.code ?? (typeof data.error === 'string' ? data.error : undefined);

      console.warn('[NexStock Supabase Auth Error]', {
        traceId: currentTraceId,
        operation: 'signup',
        httpStatus: resp.status,
        supabaseCode: safeSupabaseCode,
        message: sanitizeLogMessage(errorMsg),
      });

      if (resp.status === 422 || errorMsg.toLowerCase().includes('already') || errorMsg.toLowerCase().includes('registered')) {
        throw new AppError({
          statusCode: 409,
          errorCode: 'AUTH_EMAIL_ALREADY_EXISTS',
          title: 'Email Already Registered',
          detail: 'An account with this email address already exists. Please log in instead.',
        });
      }
      if (resp.status === 400 && errorMsg.toLowerCase().includes('password')) {
        throw new AppError({
          statusCode: 400,
          errorCode: 'AUTH_WEAK_PASSWORD',
          title: 'Weak Password',
          detail: errorMsg,
        });
      }
      throw new AppError({
        statusCode: resp.status >= 400 && resp.status < 500 ? resp.status : 400,
        errorCode: 'ERR_VALIDATION_FAILED',
        title: 'Registration Error',
        detail: errorMsg,
      });
    }

    const userId = data.user?.id ?? data.id;
    if (!userId) {
      console.error('[NexStock Supabase Auth Missing User ID]', {
        traceId: currentTraceId,
        operation: 'signup',
      });
      throw new AppError({
        statusCode: 500,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'Registration Failed',
        detail: 'Identity provider did not return a user identifier.',
      });
    }

    try {
      await ensureUserRecordDirect(
        db,
        {
          userId,
          email: normalizedEmail,
          fullName,
        },
        currentTraceId,
      );
    } catch (err) {
      if (err instanceof AppError) throw err;
      const safeDetail = sanitizeLogMessage(err instanceof Error ? err.message : String(err));
      console.error('[NexStock User Profile Sync Failure]', {
        traceId: currentTraceId,
        operation: 'signup',
        errorName: err instanceof Error ? err.name : typeof err,
        detail: safeDetail,
      });
      throw new AppError({
        statusCode: 500,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'User Profile Sync Failed',
        detail: `Failed to synchronize user account profile: ${safeDetail}`,
      });
    }

    const token = data.access_token;
    const refreshToken = data.refresh_token;
    const requiresEmailVerification = !token;

    return {
      userId,
      email: normalizedEmail,
      fullName,
      ...(token ? { token } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      requiresEmailVerification,
      message: requiresEmailVerification
        ? 'Registration successful. Please verify your email address to complete sign in.'
        : 'Registration successful.',
    };
  }

  // Local Development / Test Fallback
  const userId = generateUuidV7();
  await ensureUserRecordDirect(
    db,
    {
      userId,
      email: normalizedEmail,
      fullName,
    },
    currentTraceId,
  );

  const token = signDevJwt({
    userId,
    email: normalizedEmail,
    userMetadata: { full_name: fullName },
  });

  return {
    userId,
    email: normalizedEmail,
    fullName,
    token,
    refreshToken: `dev_refresh_${generateUuidV7()}`,
    requiresEmailVerification: false,
    message: 'Registration successful (development mode).',
  };
}

/**
 * Handles User Login via Supabase Auth or local dev fallback.
 */
export async function handleLogin(
  db: Kysely<NexStockDatabase>,
  config: AuthServiceConfig,
  input: LoginRequest,
  traceId?: string,
): Promise<LoginResponse> {
  const currentTraceId = traceId ?? `req_${generateUuidV7()}`;
  const normalizedEmail = input.email.trim().toLowerCase();

  const supabaseUrl = config.supabaseUrl ?? process.env['SUPABASE_URL'] ?? DEFAULT_SUPABASE_URL;
  const anonKey = config.supabaseAnonKey ?? process.env['SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_PUBLISHABLE_KEY'];

  // Check if live Supabase auth key is required but missing in production
  if (isProductionEnvironment(config) && (!anonKey || anonKey === 'SET_IN_LOCAL_ENV')) {
    console.error('[NexStock Auth Configuration Error]', {
      traceId: currentTraceId,
      error: 'SUPABASE_ANON_KEY (or SUPABASE_PUBLISHABLE_KEY) is missing in production environment.',
    });
    throw new AppError({
      statusCode: 503,
      errorCode: 'ERR_INTERNAL_SERVER_ERROR',
      title: 'Authentication Service Not Configured',
      detail: 'Supabase authentication is not configured in this environment. Set SUPABASE_ANON_KEY in Render environment variables.',
    });
  }

  if (anonKey && anonKey !== 'SET_IN_LOCAL_ENV') {
    let resp: Response;
    try {
      resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          email: normalizedEmail,
          password: input.password,
        }),
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      const safeDetail = sanitizeLogMessage(err instanceof Error ? err.message : String(err));
      console.error('[NexStock Auth Login Failure]', {
        traceId: currentTraceId,
        errorName: err instanceof Error ? err.name : typeof err,
        detail: safeDetail,
      });
      throw new AppError({
        statusCode: 502,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'Authentication Service Unavailable',
        detail: `Failed to communicate with authentication provider: ${safeDetail}`,
      });
    }

    const data = (await resp.json()) as SupabaseSessionResponse & SupabaseAuthErrorBody;

    if (!resp.ok) {
      console.warn('[NexStock Supabase Login Failed]', {
        traceId: currentTraceId,
        status: resp.status,
        code: data.code ?? data.error,
      });
      // Uniform error response to avoid leaking account existence
      throw new AppError({
        statusCode: 401,
        errorCode: 'AUTH_INVALID_CREDENTIALS',
        title: 'Invalid Credentials',
        detail: 'Invalid email address or password.',
      });
    }

    if (!data.access_token || !data.user?.id) {
      throw new AppError({
        statusCode: 401,
        errorCode: 'AUTH_INVALID_CREDENTIALS',
        title: 'Authentication Failed',
        detail: 'Invalid credentials or inactive session.',
      });
    }

    const userId = data.user.id;
    const fullName = data.user.user_metadata?.full_name ?? data.user.user_metadata?.name ?? normalizedEmail.split('@')[0] ?? 'User';

    try {
      await ensureUserRecordDirect(
        db,
        {
          userId,
          email: normalizedEmail,
          fullName,
        },
        currentTraceId,
      );
    } catch (err) {
      if (err instanceof AppError) throw err;
      const safeDetail = sanitizeLogMessage(err instanceof Error ? err.message : String(err));
      console.error('[NexStock User Profile Sync Failure]', {
        traceId: currentTraceId,
        operation: 'login',
        errorName: err instanceof Error ? err.name : typeof err,
        detail: safeDetail,
      });
      throw new AppError({
        statusCode: 500,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'User Profile Sync Failed',
        detail: `Failed to synchronize user account profile: ${safeDetail}`,
      });
    }

    const userProfile = await getUserProfileAndMemberships(db, userId, currentTraceId);

    return {
      token: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      ...(data.expires_in ? { expiresIn: data.expires_in } : {}),
      user: userProfile.user,
      memberships: userProfile.memberships,
    };
  }

  // Local Development / Test Fallback
  let user = await withAppUserTransaction(db, { traceId: currentTraceId }, async (trx) => {
    return trx
      .selectFrom('users')
      .select(['id', 'email', 'full_name'])
      .where('email', '=', normalizedEmail)
      .executeTakeFirst();
  });

  if (!user) {
    // In dev mode, auto-provision user if password meets minimum length
    if (input.password.length < 6) {
      throw new AppError({
        statusCode: 401,
        errorCode: 'AUTH_INVALID_CREDENTIALS',
        title: 'Invalid Credentials',
        detail: 'Invalid email address or password.',
      });
    }
    const userId = generateUuidV7();
    const fullName = normalizedEmail.split('@')[0] ?? 'Local Developer';
    await ensureUserRecordDirect(
      db,
      {
        userId,
        email: normalizedEmail,
        fullName,
      },
      currentTraceId,
    );
    user = { id: userId, email: normalizedEmail, full_name: fullName };
  }

  const token = signDevJwt({
    userId: user.id,
    email: user.email,
    userMetadata: { full_name: user.full_name },
  });

  const userProfile = await getUserProfileAndMemberships(db, user.id, currentTraceId);

  return {
    token,
    refreshToken: `dev_refresh_${generateUuidV7()}`,
    expiresIn: 86400 * 7,
    user: userProfile.user,
    memberships: userProfile.memberships,
  };
}

/**
 * Handles Token Refresh via Supabase Auth or local dev fallback.
 */
export async function handleRefreshToken(
  config: AuthServiceConfig,
  input: RefreshTokenRequest,
  traceId?: string,
): Promise<{ token: string; refreshToken?: string; expiresIn?: number }> {
  const currentTraceId = traceId ?? `req_${generateUuidV7()}`;
  const supabaseUrl = config.supabaseUrl ?? process.env['SUPABASE_URL'] ?? DEFAULT_SUPABASE_URL;
  const anonKey = config.supabaseAnonKey ?? process.env['SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_PUBLISHABLE_KEY'];

  if (anonKey && anonKey !== 'SET_IN_LOCAL_ENV') {
    try {
      const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          refresh_token: input.refreshToken,
        }),
      });

      const data = (await resp.json()) as SupabaseSessionResponse & SupabaseAuthErrorBody;

      if (!resp.ok || !data.access_token) {
        throw new AppError({
          statusCode: 401,
          errorCode: 'IAM_UNAUTHENTICATED_TOKEN',
          title: 'Session Expired',
          detail: 'Your refresh session has expired or been revoked. Please log in again.',
        });
      }

      return {
        token: data.access_token,
        ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
        ...(data.expires_in ? { expiresIn: data.expires_in } : {}),
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      const safeDetail = sanitizeLogMessage(err instanceof Error ? err.message : String(err));
      console.error('[NexStock Auth Refresh Failure]', {
        traceId: currentTraceId,
        errorName: err instanceof Error ? err.name : typeof err,
        detail: safeDetail,
      });
      throw new AppError({
        statusCode: 502,
        errorCode: 'ERR_INTERNAL_SERVER_ERROR',
        title: 'Authentication Service Unavailable',
        detail: `Failed to communicate with authentication provider: ${safeDetail}`,
      });
    }
  }

  // Local dev mode: issue new dev token
  return {
    token: signDevJwt({ userId: generateUuidV7() }),
    refreshToken: input.refreshToken,
    expiresIn: 86400 * 7,
  };
}

/**
 * Handles User Logout via Supabase Auth revocation.
 */
export async function handleLogout(
  config: AuthServiceConfig,
  token?: string,
  traceId?: string,
): Promise<{ success: boolean; message: string }> {
  const supabaseUrl = config.supabaseUrl ?? process.env['SUPABASE_URL'] ?? DEFAULT_SUPABASE_URL;
  const anonKey = config.supabaseAnonKey ?? process.env['SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_PUBLISHABLE_KEY'];

  if (anonKey && anonKey !== 'SET_IN_LOCAL_ENV' && token) {
    try {
      await fetch(`${supabaseUrl}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (err) {
      // Best-effort remote revocation; local session is cleared regardless
      console.warn('[NexStock Supabase Logout Warning]', {
        traceId,
        message: sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  return { success: true, message: 'Logged out successfully.' };
}

/**
 * Handles Password Reset Request (Privacy-Preserving).
 */
export async function handlePasswordResetRequest(
  config: AuthServiceConfig,
  input: PasswordResetRequest,
  redirectTo?: string,
  traceId?: string,
): Promise<{ message: string }> {
  const normalizedEmail = input.email.trim().toLowerCase();
  const supabaseUrl = config.supabaseUrl ?? process.env['SUPABASE_URL'] ?? DEFAULT_SUPABASE_URL;
  const anonKey = config.supabaseAnonKey ?? process.env['SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_PUBLISHABLE_KEY'];

  if (anonKey && anonKey !== 'SET_IN_LOCAL_ENV') {
    try {
      await fetch(`${supabaseUrl}/auth/v1/recover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          email: normalizedEmail,
          ...(redirectTo ? { redirect_to: redirectTo } : {}),
        }),
      });
    } catch (err) {
      // Return uniform message to avoid leaking errors or timing
      console.warn('[NexStock Supabase Recover Warning]', {
        traceId,
        message: sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  return {
    message: 'If an account exists with this email address, a password recovery link has been sent.',
  };
}

/**
 * Retrieves the authenticated user's profile and list of tenant memberships
 * under safe user-scoped transaction RLS.
 */
export async function getUserProfileAndMemberships(
  db: Kysely<NexStockDatabase>,
  userId: string,
  traceId: string,
): Promise<UserMeResponse> {
  return withUserTransaction(db, { userId, traceId }, async (trx) => {
    // 1. Fetch user record and active memberships in parallel
    const [userRow, membershipRows] = await Promise.all([
      trx
        .selectFrom('users')
        .select(['id', 'email', 'full_name'])
        .where('id', '=', userId)
        .executeTakeFirst(),
      trx
        .selectFrom('tenant_memberships')
        .innerJoin('tenants', 'tenants.id', 'tenant_memberships.tenant_id')
        .select([
          'tenant_memberships.id as membership_id',
          'tenant_memberships.tenant_id',
          'tenant_memberships.status as membership_status',
          'tenant_memberships.all_locations_access as all_locations_access',
          'tenants.legal_name as business_name',
          'tenants.slug',
          'tenants.base_currency',
          'tenants.default_timezone',
          'tenants.status as tenant_status',
        ])
        .where('tenant_memberships.user_id', '=', userId)
        .where('tenant_memberships.status', '=', 'ACTIVE')
        .execute(),
    ]);

    const user: AuthUserSummary = {
      id: userRow?.id ?? userId,
      email: userRow?.email ?? '',
      fullName: userRow?.full_name ?? '',
    };

    if (membershipRows.length === 0) {
      return {
        user,
        memberships: [],
      };
    }

    const membershipIds = membershipRows.map((m) => m.membership_id);
    const tenantIds = Array.from(new Set(membershipRows.map((m) => m.tenant_id)));

    // 2. Batch-fetch roles, permissions, scopes, and branches across memberships in parallel
    const [
      roleRows,
      allBranchRows,
      permRows,
      scopeRows,
      linkedEmployeeRows,
    ] = await Promise.all([
      trx
        .selectFrom('member_role_assignments')
        .innerJoin('roles', (join) =>
          join
            .onRef('roles.tenant_id', '=', 'member_role_assignments.tenant_id')
            .onRef('roles.id', '=', 'member_role_assignments.role_id'),
        )
        .select([
          'member_role_assignments.membership_id as membership_id',
          'member_role_assignments.role_id as role_id',
          'roles.code as role_code',
          'roles.is_system_role as is_system_role',
        ])
        .where('member_role_assignments.membership_id', 'in', membershipIds)
        .execute(),
      trx
        .selectFrom('branches')
        .select(['id', 'tenant_id', 'code', 'name', 'default_warehouse_id', 'timezone'])
        .where('tenant_id', 'in', tenantIds)
        .where('is_active', '=', true)
        .orderBy('name', 'asc')
        .execute(),
      trx
        .selectFrom('role_permissions')
        .select(['role_id', 'permission_key'])
        .where('tenant_id', 'in', tenantIds)
        .execute(),
      trx
        .selectFrom('member_location_scopes')
        .select(['membership_id', 'branch_id', 'warehouse_id'])
        .where('membership_id', 'in', membershipIds)
        .execute(),
      trx
        .selectFrom('employees')
        .select(['tenant_id', 'primary_branch_id'])
        .where('tenant_id', 'in', tenantIds)
        .where('linked_user_id', '=', userId)
        .where('employment_status', '=', 'ACTIVE')
        .execute(),
    ]);

    const rolesByMembershipId = new Map<
      string,
      Array<{ roleId: string; roleCode: string; isSystemRole: boolean }>
    >();
    for (const r of roleRows) {
      const list = rolesByMembershipId.get(r.membership_id) ?? [];
      list.push({
        roleId: r.role_id,
        roleCode: r.role_code,
        isSystemRole: Boolean(r.is_system_role),
      });
      rolesByMembershipId.set(r.membership_id, list);
    }

    const permsByRoleId = new Map<string, Set<string>>();
    for (const p of permRows) {
      let set = permsByRoleId.get(p.role_id);
      if (!set) {
        set = new Set<string>();
        permsByRoleId.set(p.role_id, set);
      }
      set.add(p.permission_key);
    }

    const scopesByMembershipId = new Map<
      string,
      { branches: Set<string>; warehouses: Set<string> }
    >();
    for (const s of scopeRows) {
      let entry = scopesByMembershipId.get(s.membership_id);
      if (!entry) {
        entry = { branches: new Set<string>(), warehouses: new Set<string>() };
        scopesByMembershipId.set(s.membership_id, entry);
      }
      if (s.branch_id) entry.branches.add(s.branch_id);
      if (s.warehouse_id) entry.warehouses.add(s.warehouse_id);
    }

    const employeeBranchByTenantId = new Map<string, string>();
    for (const emp of linkedEmployeeRows) {
      if (emp.primary_branch_id) {
        employeeBranchByTenantId.set(emp.tenant_id, emp.primary_branch_id);
      }
    }

    const branchesByTenantId = new Map<string, typeof allBranchRows>();
    for (const b of allBranchRows) {
      const list = branchesByTenantId.get(b.tenant_id) ?? [];
      list.push(b);
      branchesByTenantId.set(b.tenant_id, list);
    }

    const memberships: TenantMembershipSummary[] = membershipRows.map((m) => {
      const assigned = rolesByMembershipId.get(m.membership_id) ?? [];
      const roleCodes = assigned.map((r) => r.roleCode);
      const isOwnerOrAdmin =
        roleCodes.includes('TENANT_OWNER') || roleCodes.includes('ORG_ADMIN');
      const allLocationsAccess = Boolean(m.all_locations_access || isOwnerOrAdmin);

      const permissions = new Set<string>();
      for (const role of assigned) {
        const dbPerms = permsByRoleId.get(role.roleId);
        if (dbPerms) {
          for (const p of dbPerms) permissions.add(p);
        }
        if (role.isSystemRole && role.roleCode in SYSTEM_ROLE_DEFINITIONS) {
          const sysDef = SYSTEM_ROLE_DEFINITIONS[role.roleCode as SystemRoleCode];
          for (const p of sysDef.permissions) permissions.add(p);
        }
      }

      const scopes = scopesByMembershipId.get(m.membership_id);
      const allowedBranches = new Set<string>(scopes ? scopes.branches : []);
      const allowedWarehouses = new Set<string>(scopes ? scopes.warehouses : []);

      // Auto-heal location scopes if none specified
      if (!allLocationsAccess && allowedBranches.size === 0) {
        const empBranch = employeeBranchByTenantId.get(m.tenant_id);
        if (empBranch) {
          allowedBranches.add(empBranch);
        }
      }

      const tenantBranches = branchesByTenantId.get(m.tenant_id) ?? [];
      if (
        !allLocationsAccess &&
        allowedBranches.size === 0 &&
        tenantBranches.length === 1 &&
        tenantBranches[0]
      ) {
        allowedBranches.add(tenantBranches[0].id);
      }

      // Filter visible branches if user has restricted location access
      const permittedBranches = allLocationsAccess
        ? tenantBranches
        : tenantBranches.filter((b) => allowedBranches.has(b.id));

      return {
        tenantId: m.tenant_id,
        businessName: m.business_name,
        slug: m.slug,
        baseCurrency: m.base_currency,
        status: m.tenant_status,
        role: roleCodes[0] ?? 'MEMBER',
        roles: roleCodes,
        permissions: Array.from(permissions),
        allLocationsAccess,
        allowedBranchIds: allLocationsAccess ? null : Array.from(allowedBranches),
        allowedWarehouseIds: allLocationsAccess ? null : Array.from(allowedWarehouses),
        timezone: m.default_timezone ?? 'UTC',
        branches: permittedBranches.map((b) => ({
          id: b.id,
          code: b.code,
          name: b.name,
          defaultWarehouseId: b.default_warehouse_id,
          timezone: b.timezone ?? m.default_timezone ?? 'UTC',
        })),
      };
    });

    return {
      user,
      memberships,
    };
  });
}
