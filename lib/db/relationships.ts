import 'server-only';

/**
 * The embedded-resource map.
 *
 * MIGRATION NOTE (Supabase -> Neon):
 * PostgREST discovered these relationships from the foreign keys at runtime.
 * Nothing does that here, and guessing a join is exactly the kind of mistake
 * that silently returns the wrong rows — so every relationship the application
 * embeds is declared explicitly below, and anything not declared is refused.
 *
 * Every relationship in this application is to-ONE. That was checked against
 * the schema rather than assumed:
 *
 *   applications.job_id        -> jobs.id                    (FK, not null)
 *   applications.candidate_id  -> candidate_profiles.id      (FK, not null)
 *   application_scores.application_id   -> applications.id   (FK + UNIQUE)
 *   application_analyses.application_id -> applications.id   (FK + UNIQUE)
 *   candidate_profiles.user_id -> profiles.id                (FK + UNIQUE)
 *   jobs.recruiter_id          -> profiles.id                (FK, not null)
 *
 * The two reverse relationships (scores, analyses) are to-one because of the
 * UNIQUE constraint on application_id, not merely because the application
 * happens to expect one row. If that constraint were ever dropped, these
 * entries would be wrong and the `cardinality` field is where that would be
 * fixed.
 *
 * Consumers read these as objects (`a.jobs?.title`), never arrays, which
 * matches to-one embedding. A missing related row yields null.
 */

export interface Relationship {
  /** The table being embedded. */
  table: string;
  /** Column on the parent row used to match. */
  localColumn: string;
  /** Column on the embedded table used to match. */
  foreignColumn: string;
  /**
   * Only 'one' exists in this application. Declared anyway so that adding a
   * to-many relationship later is a deliberate, visible change rather than an
   * accidental shape difference.
   */
  cardinality: 'one';
}

type Map = Record<string, Record<string, Relationship>>;

export const RELATIONSHIPS: Map = {
  applications: {
    jobs: {
      table: 'jobs',
      localColumn: 'job_id',
      foreignColumn: 'id',
      cardinality: 'one',
    },
    candidate_profiles: {
      table: 'candidate_profiles',
      localColumn: 'candidate_id',
      foreignColumn: 'id',
      cardinality: 'one',
    },
    application_scores: {
      table: 'application_scores',
      localColumn: 'id',
      foreignColumn: 'application_id',
      cardinality: 'one',
    },
    application_analyses: {
      table: 'application_analyses',
      localColumn: 'id',
      foreignColumn: 'application_id',
      cardinality: 'one',
    },
  },
  candidate_profiles: {
    profiles: {
      table: 'profiles',
      localColumn: 'user_id',
      foreignColumn: 'id',
      cardinality: 'one',
    },
  },
  jobs: {
    profiles: {
      table: 'profiles',
      localColumn: 'recruiter_id',
      foreignColumn: 'id',
      cardinality: 'one',
    },
  },
};

export function relationship(parent: string, name: string): Relationship | null {
  return RELATIONSHIPS[parent]?.[name] ?? null;
}
