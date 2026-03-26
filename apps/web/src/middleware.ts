import { defineMiddleware } from 'astro:middleware';

const PUBLIC_PATHS = new Set(['/login', '/signup', '/recover', '/recovery-setup', '/logout']);

export const onRequest = defineMiddleware((ctx, next) => {
  if (PUBLIC_PATHS.has(ctx.url.pathname)) return next();

  const token = ctx.cookies.get('token')?.value;
  if (!token) return ctx.redirect('/login');

  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (!payload.confirmed) return ctx.redirect('/recovery-setup');
  } catch {
    return ctx.redirect('/login');
  }

  return next();
});
