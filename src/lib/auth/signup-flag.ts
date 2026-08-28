// Feature flag for public self-service signup (the "free" /signup form,
// reached without an invite token). Invited signup (/signup?invite=<token>,
// completing a team invite from /join/<token>) is never gated by this flag —
// see SPEC decision: an operator who wants "invite-only" still needs
// existing invites to keep working.
//
// Default (variable undeclared) is ENABLED — public signup stays open
// unless an operator explicitly opts out. Only the literal "false"
// (case-insensitive) disables it; any other declared value keeps it on.
export function isPublicSignupEnabled(
  value: string | undefined = process.env.NEXT_PUBLIC_SIGNUP_ENABLED
): boolean {
  return (value ?? '').trim().toLowerCase() !== 'false';
}
