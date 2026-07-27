create extension if not exists pgcrypto;

create type accreditation_request_status as enum (
  'draft',
  'evidence_uploaded',
  'manifest_created',
  'submitted_onchain',
  'approved',
  'rejected',
  'changes_requested',
  'cancelled'
);

create type criteria_bundle_status as enum (
  'active',
  'deprecated',
  'archived'
);

create table organizations_offchain (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  organization_pda text unique,
  name text not null,
  legal_name text,
  website_url text,
  description text,
  primary_organization_type text,
  metadata_json jsonb not null default '{}'::jsonb,
  metadata_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index organizations_offchain_wallet_address_idx
  on organizations_offchain (wallet_address);

create table criteria_bundles (
  id uuid primary key default gen_random_uuid(),
  criteria_key text not null,
  version integer not null,
  title text not null,
  description text,
  criteria_json jsonb not null default '{}'::jsonb,
  criteria_hash text not null,
  global_criteria_set_pda text,
  status criteria_bundle_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (criteria_key, version)
);

create table accreditation_requests_offchain (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations_offchain (id) on delete cascade,
  organization_pda text,
  accreditation_request_pda text unique,
  criteria_bundle_id uuid references criteria_bundles (id),
  criteria_bundle_hash text,
  evidence_manifest_id uuid,
  evidence_manifest_hash text,
  metadata_uri text,
  metadata_hash text,
  onchain_signature text,
  status accreditation_request_status not null default 'draft',
  submitted_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index accreditation_requests_organization_id_idx
  on accreditation_requests_offchain (organization_id);

create index accreditation_requests_status_idx
  on accreditation_requests_offchain (status);

create table evidence_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations_offchain (id) on delete cascade,
  accreditation_request_id uuid references accreditation_requests_offchain (id) on delete cascade,
  original_filename text not null,
  stored_filename text not null,
  storage_path text not null unique,
  mime_type text not null,
  byte_size bigint not null,
  sha256_hash text not null,
  uploaded_by_wallet text not null,
  created_at timestamptz not null default now()
);

create index evidence_documents_organization_id_idx
  on evidence_documents (organization_id);

create index evidence_documents_request_id_idx
  on evidence_documents (accreditation_request_id);

create table evidence_manifests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations_offchain (id) on delete cascade,
  accreditation_request_id uuid not null references accreditation_requests_offchain (id) on delete cascade,
  manifest_json jsonb not null,
  manifest_hash text not null unique,
  manifest_storage_path text not null unique,
  created_at timestamptz not null default now()
);

alter table accreditation_requests_offchain
  add constraint accreditation_requests_manifest_fk
  foreign key (evidence_manifest_id)
  references evidence_manifests (id)
  on delete set null;

create table admin_review_notes (
  id uuid primary key default gen_random_uuid(),
  accreditation_request_id uuid not null references accreditation_requests_offchain (id) on delete cascade,
  admin_wallet text not null,
  note text not null,
  created_at timestamptz not null default now()
);

create index admin_review_notes_request_id_idx
  on admin_review_notes (accreditation_request_id);

