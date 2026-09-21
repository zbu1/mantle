/**
 * What a `ProfilePicker` currently has selected. One value rather than
 * separate "selected id" / "creating" / "plaintext" flags, so the options can't
 * disagree about which of them is chosen.
 */
export type ProfileChoice =
  /** An existing profile. */
  | { kind: 'profile'; id: string }
  /** The inline form that creates a new profile is open. */
  | { kind: 'new' }
  /** "No encryption" — only offered when the picker is told `allowPlaintext`. */
  | { kind: 'plaintext' }
  | null;

/** The id of the chosen profile, or null when the choice isn't an existing profile. */
export function chosenProfileId(choice: ProfileChoice): string | null {
  return choice?.kind === 'profile' ? choice.id : null;
}
