create type social_author_type as enum (
  'user',
  'organization',
  'admin'
);

create type social_content_status as enum (
  'active',
  'tombstoned',
  'hidden'
);

create type social_content_kind as enum (
  'post',
  'article'
);

create type social_attachment_owner_type as enum (
  'post_version',
  'comment_version'
);

create table social_posts (
  id uuid primary key default gen_random_uuid(),
  author_type social_author_type not null,
  author_wallet text not null,
  user_profile_account text,
  organization_account text,
  status social_content_status not null default 'active',
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index social_posts_author_wallet_idx
  on social_posts (author_wallet);

create index social_posts_organization_account_idx
  on social_posts (organization_account);

create index social_posts_created_at_idx
  on social_posts (created_at desc);

create table social_post_versions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references social_posts (id) on delete cascade,
  version_number integer not null,
  content_kind social_content_kind not null default 'post',
  content_json jsonb not null,
  canonical_json text not null,
  content_hash text not null,
  previous_version_id uuid references social_post_versions (id) on delete set null,
  author_trust_snapshot jsonb not null default '{}'::jsonb,
  edit_reason text,
  created_at timestamptz not null default now(),
  unique (post_id, version_number)
);

create unique index social_post_versions_hash_idx
  on social_post_versions (content_hash);

alter table social_posts
  add constraint social_posts_current_version_fk
  foreign key (current_version_id)
  references social_post_versions (id)
  on delete set null;

create table social_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references social_posts (id) on delete cascade,
  parent_comment_id uuid references social_comments (id) on delete cascade,
  author_type social_author_type not null,
  author_wallet text not null,
  user_profile_account text,
  organization_account text,
  status social_content_status not null default 'active',
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index social_comments_post_id_idx
  on social_comments (post_id);

create index social_comments_author_wallet_idx
  on social_comments (author_wallet);

create table social_comment_versions (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references social_comments (id) on delete cascade,
  version_number integer not null,
  content_json jsonb not null,
  canonical_json text not null,
  content_hash text not null,
  previous_version_id uuid references social_comment_versions (id) on delete set null,
  author_trust_snapshot jsonb not null default '{}'::jsonb,
  edit_reason text,
  created_at timestamptz not null default now(),
  unique (comment_id, version_number)
);

create unique index social_comment_versions_hash_idx
  on social_comment_versions (content_hash);

alter table social_comments
  add constraint social_comments_current_version_fk
  foreign key (current_version_id)
  references social_comment_versions (id)
  on delete set null;

create table social_attachments (
  id uuid primary key default gen_random_uuid(),
  owner_type social_attachment_owner_type not null,
  owner_version_id uuid not null,
  storage_uri text not null,
  filename text not null,
  mime_type text not null,
  byte_size bigint not null,
  content_hash text not null,
  created_at timestamptz not null default now()
);

create index social_attachments_owner_idx
  on social_attachments (owner_type, owner_version_id);
