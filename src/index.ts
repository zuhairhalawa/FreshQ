export { searchDiscussions, parseDiscussionNode, parsePage, SEARCH_RESULT_CAP } from "./client.js";
export { buildSearchQuery } from "./query.js";
export { parseDuration, formatAge } from "./duration.js";
export { FreshQError, ExitCode } from "./errors.js";
export { createDefaultTransport, createGhTransport, createFetchTransport } from "./transport.js";
export type { Transport } from "./transport.js";
export type { Discussion, SearchOptions, SearchResult } from "./types.js";
