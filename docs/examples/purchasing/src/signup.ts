/** Employees only: an email may create an account only on the company's domain (ADMIN_EMAIL always signs in). */
export async function allowSignUp(env: Env, email: string): Promise<boolean> {
  // AGENT: set EMPLOYEE_DOMAIN in wrangler.jsonc vars; for a per-person list, see the club-events example.
  return email.toLowerCase().endsWith(`@${env.EMPLOYEE_DOMAIN.toLowerCase()}`);
}
