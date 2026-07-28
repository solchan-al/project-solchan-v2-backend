create type admin_metadata_record_type as enum (
  'taxonomy',
  'criteria'
);

create table admin_metadata_documents (
  id uuid primary key default gen_random_uuid(),
  record_type admin_metadata_record_type not null,
  record_kind text not null,
  record_key text not null,
  record_version integer,
  content_json jsonb not null,
  canonical_json text not null,
  content_hash text not null unique,
  storage_path text not null unique,
  created_by_wallet text,
  created_at timestamptz not null default now()
);

create index admin_metadata_documents_record_idx
  on admin_metadata_documents (record_type, record_kind, record_key, record_version);
