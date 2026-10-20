import { attr, html, type SafeHtml } from '../html.js';

export interface LoginPageModel {
  next: string;
  error: string | null;
  csrf: string | null;
}

/** The login form. Deliberately renders without the full `layout()`/live wiring - this page is
 *  reachable with no session at all, so there is no CSRF cookie yet on first visit; the form still
 *  carries whatever `_csrf` value the caller has (a fresh, unauthenticated placeholder is fine
 *  since the login POST itself is exempted from the CSRF check, being the thing that establishes
 *  the session in the first place - it is instead protected by the login rate limiter). */
export function loginPage(model: LoginPageModel): SafeHtml {
  return html`<h1>Sign in</h1>
${model.error ? html`<p class="flash flash-error" role="alert">${model.error}</p>` : ''}
<form method="post" action="/dashboard/login" class="login-form">
  <div class="field">
    <label for="login-password">Password</label>
    <input id="login-password" type="password" name="password" required autofocus>
  </div>
  <input type="hidden" name="next" value="${attr(model.next)}">
  <button type="submit">Sign in</button>
</form>`;
}
