/** A GitHub Discussion, normalised from the GraphQL `Discussion` type. */
export interface Discussion {
  id: string;
  number: number;
  title: string;
  url: string;
  /** `owner/name` */
  repository: string;
  isPrivate: boolean;
  author: string | null;
  /** ISO-8601 creation time (never the "updated" time). */
  createdAt: string;
  updatedAt: string;
  /** Top-level comment count (`comments.totalCount`). */
  comments: number;
  category: string;
  /** Whether the category supports marking an accepted answer (Q&A style). */
  isAnswerable: boolean;
  /**
   * Accepted-answer state. `null` when the category is not answerable
   * (the API itself returns null there; "unanswered" has no meaning for such categories).
   */
  isAnswered: boolean | null;
  answerChosenAt: string | null;
}

export type AnswerFilter = "any" | "answerable" | "unanswered";

/** Which part of a discussion free-text terms are matched against. */
export type InScope = "title" | "body" | "comments";

export interface SearchOptions {
  /** Start of the window (inclusive), epoch ms. */
  sinceMs: number;
  /** Maximum number of discussions to return. */
  limit: number;
  answer: AnswerFilter;
  zeroComments: boolean;
  repos: readonly string[];
  orgs: readonly string[];
  /** Free-text terms; each is ANDed. Whitespace-containing terms are exact phrases. */
  terms: readonly string[];
  inScope?: InScope | undefined;
  /** Upper bound on GraphQL requests for one run. */
  maxRequests: number;
}

export interface RateLimitInfo {
  cost: number;
  remaining: number;
  limit: number;
  resetAt: string;
}

export interface SearchResult {
  items: Discussion[];
  /**
   * True when the search covered the whole requested window, or collected `limit`
   * results from the newest end (so the returned items are provably the newest matches).
   */
  complete: boolean;
  /** Oldest timestamp that was fully searched (ISO). Equals the window start when everything was covered. */
  coveredFrom: string;
  requests: number;
  rateLimit: RateLimitInfo | null;
  warnings: string[];
}
