import { createHmac } from 'crypto';
import { defineMiddleware } from 'astro:middleware';

const PUBLIC_PATHS = new Set(['/login', '/signup', '/recover', '/recovery-setup', '/logout']);

function verifyJwt(token: string, secret: string): { sub: number; username: string; confirmed: boolean } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const sig = createHmac('sha256', secret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64url');
    if (sig !== parts[2]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export const onRequest = defineMiddleware((ctx, next) => {
  if (PUBLIC_PATHS.has(ctx.url.pathname)) return next();

  const token = ctx.cookies.get('token')?.value;
  if (!token) return ctx.redirect('/login');

  const secret = process.env.JWT_SECRET ?? '';
  const payload = verifyJwt(token, secret);
  if (!payload) return ctx.redirect('/login');
  if (!payload.confirmed) return ctx.redirect('/recovery-setup');

  return next();
});
