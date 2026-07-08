import type { PGlite } from "@electric-sql/pglite"
import type postgres from "postgres"

export const postgresIndexSchemaSql = `
create table if not exists workspace_memberships (
  id text primary key,
  workspace_id text not null,
  user_id text not null,
  role text not null,
  created_at bigint not null
);
create unique index if not exists workspace_memberships_workspace_user_idx
  on workspace_memberships (workspace_id, user_id);
create index if not exists workspace_memberships_user_idx on workspace_memberships (user_id);
create index if not exists workspace_memberships_workspace_idx on workspace_memberships (workspace_id);

create table if not exists thread_projections (
  thread_id text primary key,
  workspace_id text not null,
  user_id text,
  last_user_id text,
  latest_message_id text,
  latest_message_role text,
  latest_message_text text,
  latest_message_created_at bigint,
  title_text text,
  diff_additions integer not null default 0,
  diff_modifications integer not null default 0,
  diff_deletions integer not null default 0,
  active_turn_id text,
  active_turn_status text,
  last_context_tokens integer,
  last_model text,
  archived integer not null default 0,
  visibility text not null default 'private',
  last_sequence integer not null,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists thread_projections_updated_idx on thread_projections (updated_at);
create index if not exists thread_projections_workspace_idx on thread_projections (workspace_id);

create table if not exists thread_files (
  thread_id text not null,
  path text not null,
  first_seen_at bigint not null,
  last_seen_at bigint not null
);
create unique index if not exists thread_files_thread_path_idx on thread_files (thread_id, path);
create index if not exists thread_files_path_idx on thread_files (path);
create index if not exists thread_files_thread_idx on thread_files (thread_id);

create table if not exists projects (
  project_id text primary key,
  name text not null,
  repo_origin text not null,
  default_branch text not null default 'main',
  template_id text,
  env text not null,
  created_at bigint not null,
  updated_at bigint not null
);
create unique index if not exists projects_name_idx on projects (name);
create index if not exists projects_repo_origin_idx on projects (repo_origin);

create table if not exists orbs (
  orb_id text primary key,
  thread_id text not null,
  project_id text not null,
  sandbox_id text,
  status text not null,
  base_commit text,
  endpoint_url text,
  token text,
  created_at bigint not null,
  last_active_at bigint not null
);
create index if not exists orbs_project_idx on orbs (project_id);
create index if not exists orbs_status_idx on orbs (status);

create table if not exists orb_usage_intervals (
  id text primary key,
  orb_id text not null,
  started_at bigint not null,
  ended_at bigint
);
create index if not exists orb_usage_intervals_orb_idx on orb_usage_intervals (orb_id);
create index if not exists orb_usage_intervals_started_idx on orb_usage_intervals (started_at);

create table if not exists artifacts (
  id text primary key,
  thread_id text not null,
  workspace_id text,
  turn_id text,
  kind text not null,
  title text,
  content text not null,
  metadata text,
  created_at bigint not null
);
create index if not exists artifacts_thread_created_idx on artifacts (thread_id, created_at);
create index if not exists artifacts_workspace_kind_created_idx on artifacts (workspace_id, kind, created_at);
create index if not exists artifacts_kind_idx on artifacts (kind);

create table if not exists mcp_server_approvals (
  id text primary key,
  workspace_root text not null,
  server_name text not null,
  fingerprint text not null,
  approved_at bigint not null
);
create unique index if not exists mcp_server_approvals_workspace_server_fingerprint_idx
  on mcp_server_approvals (workspace_root, server_name, fingerprint);
create index if not exists mcp_server_approvals_workspace_idx on mcp_server_approvals (workspace_root);

create table if not exists thread_memory_chunks (
  id text primary key,
  thread_id text not null,
  turn_id text not null,
  workspace_id text not null,
  text text not null,
  embedding bytea not null,
  created_at bigint not null
);
create unique index if not exists thread_memory_chunks_thread_turn_idx
  on thread_memory_chunks (thread_id, turn_id);
create index if not exists thread_memory_chunks_workspace_created_idx
  on thread_memory_chunks (workspace_id, created_at);
create index if not exists thread_memory_chunks_thread_created_idx
  on thread_memory_chunks (thread_id, created_at);

create table if not exists user_tokens (
  token_hash text primary key,
  user_id text not null,
  label text,
  created_at bigint not null,
  revoked_at bigint
);
create index if not exists user_tokens_user_idx on user_tokens (user_id);
`

export const applyPostgresIndexSchema = async (client: PGlite | { unsafe: (query: string) => Promise<unknown> }) => {
  if (isPglite(client)) {
    await client.exec(postgresIndexSchemaSql)
    return
  }
  await client.unsafe(postgresIndexSchemaSql)
}

const isPglite = (client: unknown): client is PGlite =>
  typeof client === "object" &&
  client !== null &&
  typeof (client as PGlite).exec === "function" &&
  typeof (client as PGlite).query === "function"
