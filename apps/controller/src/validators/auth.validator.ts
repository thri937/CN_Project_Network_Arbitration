import { z } from 'zod';
import { displayNameSchema, emailSchema } from '@/models/base.model';

/**
 * Authentication request schemas.
 *
 * Length bounds on tokens are not cosmetic: an unbounded string field is a cheap
 * amplification vector, since every rejected value still costs a parse and a log line.
 * Firebase ID tokens run to roughly 1 KB; 4 KB is generous headroom with a hard ceiling.
 */

export const createSessionSchema = z
  .object({
    /** Provider-issued ID token (Firebase `getIdToken()` on the client). */
    idToken: z.string().min(16).max(4096),
  })
  .strict();

export const refreshSessionSchema = z
  .object({
    refreshToken: z.string().min(16).max(4096),
  })
  .strict();

export const logoutSchema = z
  .object({
    /** Advance the session watermark, invalidating every outstanding token. */
    everywhere: z.boolean().default(false),
  })
  .strict();

/**
 * Development-only sign-in.
 *
 * The route that consumes this schema is mounted ONLY when the dev auth adapter is active,
 * and the adapter itself refuses to construct under `NODE_ENV=production`. Two independent
 * guards, because a single one is a single point of failure for an endpoint that hands out
 * identities on request.
 */
export const devLoginSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .transform((val) => (val.includes('@') ? val : `${val}@example.com`))
      .pipe(emailSchema),
    displayName: displayNameSchema.optional(),
  })
  .strict();

export type CreateSessionPayload = z.infer<typeof createSessionSchema>;
export type RefreshSessionPayload = z.infer<typeof refreshSessionSchema>;
export type LogoutPayload = z.infer<typeof logoutSchema>;
export type DevLoginPayload = z.infer<typeof devLoginSchema>;
