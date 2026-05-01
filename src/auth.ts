import { createRemoteJWKSet, jwtVerify } from 'jose';

export type AuthMode = 'noauth' | 'legacy_bearer' | 'oauth';

export function getAuthMode(): AuthMode {
  const mode = process.env.AUTH_MODE || 'legacy_bearer';
  if (mode === 'noauth' || mode === 'legacy_bearer' || mode === 'oauth') return mode;
  console.warn(`Unknown AUTH_MODE=${mode}, defaulting to legacy_bearer`);
  return 'legacy_bearer';
}

export function getOAuthRequiredScope() {
  return process.env.OAUTH_REQUIRED_SCOPE || 'cli:run';
}

export function getOAuthResource() {
  return process.env.OAUTH_RESOURCE || process.env.MCP_PUBLIC_ORIGIN || 'http://localhost:9999';
}

export function getOAuthAudience() {
  return process.env.OAUTH_AUDIENCE || getOAuthResource();
}

export function getOAuthIssuer() {
  return process.env.OAUTH_ISSUER;
}

export function getOAuthJwksUri() {
  return process.env.OAUTH_JWKS_URI;
}

const jwksByUri = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getJWKS() {
  const uri = getOAuthJwksUri();
  if (!uri) throw new Error('OAUTH_JWKS_URI not configured');
  if (!jwksByUri.has(uri)) {
    jwksByUri.set(uri, createRemoteJWKSet(new URL(uri)));
  }
  return jwksByUri.get(uri)!;
}

export async function verifyAccessToken(token: string) {
  const issuer = getOAuthIssuer();
  const audience = getOAuthAudience();
  const requiredScope = getOAuthRequiredScope();

  if (!issuer) throw new Error('OAUTH_ISSUER not configured');
  if (!audience) throw new Error('OAUTH_AUDIENCE, OAUTH_RESOURCE, or MCP_PUBLIC_ORIGIN not configured');

  const { payload } = await jwtVerify(token, getJWKS(), {
    issuer,
    audience,
    clockTolerance: 60,
  });

  const scopes = String(payload.scope || '').split(/\s+/).filter(Boolean);
  if (!scopes.includes(requiredScope)) {
    throw new Error(`Missing required scope: ${requiredScope}`);
  }

  return payload;
}

export function getOAuthProtectedResourceMetadata() {
  const resource = getOAuthResource();
  const issuer = getOAuthIssuer();
  if (!resource || !issuer) return null;

  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [getOAuthRequiredScope()],
    bearer_methods_supported: ['header'],
    resource_documentation: `${resource}/docs`,
  };
}

export function getWWWAuthenticateHeader() {
  const resource = getOAuthResource();
  const scope = getOAuthRequiredScope();
  return `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource", scope="${scope}"`;
}

export function getOAuthSecurityScheme() {
  return {
    type: 'oauth2',
    scopes: [getOAuthRequiredScope()],
  };
}

export function addToolSecurityMetadata<T extends Record<string, any>>(tool: T): T {
  if (getAuthMode() !== 'oauth') return tool;

  const scheme = getOAuthSecurityScheme();
  return {
    ...tool,
    securitySchemes: [scheme],
    _meta: {
      ...(tool._meta || {}),
      securitySchemes: [scheme],
    },
  };
}
